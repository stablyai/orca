import { Worker, type WorkerOptions } from 'node:worker_threads'

/** V8's default CodeRange (512 MB on x64) costs every worker ~600 MB of address space, so a few
 * workers exhaust a `ulimit -v` host (#37538). Worker JIT code stays far below this. */
export const WORKER_CODE_RANGE_MB = 64

export function spawnWorkerThread(filename: string | URL, options: WorkerOptions = {}): Worker {
  const source = String(filename).endsWith('.ts')
  return new Worker(filename, {
    ...options,
    ...(source
      ? {
          execArgv: [
            ...(options.execArgv ?? process.execArgv),
            '--import',
            `data:text/javascript,${encodeURIComponent(sourceImportHook())}`
          ]
        }
      : {}),
    resourceLimits: { codeRangeSizeMb: WORKER_CODE_RANGE_MB, ...options.resourceLimits }
  })
}

// Source hosts share the plugin worker's TypeScript transform; deployed entries stay bundled JS.
function sourceImportHook(): string {
  return `
import { registerHooks, createRequire } from 'node:module';
const { transform } = createRequire(${JSON.stringify(__filename)})('sucrase');
import { extname } from 'node:path';
import { readFileSync } from 'node:fs';
registerHooks({ load(url, context, next) {
  if (url.endsWith('.ts')) {
    return { format: 'module', source: transform(readFileSync(new URL(url), 'utf8'), { transforms: ['typescript'], disableESTransforms: true, filePath: new URL(url).pathname }).code, shortCircuit: true };
  }
  return next(url, context);
}, resolve(specifier, context, next) {
  try { return next(specifier, context); }
  catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !extname(specifier)) {
      return next(specifier + '.ts', context);
    }
    throw error;
  }
} });`
}
