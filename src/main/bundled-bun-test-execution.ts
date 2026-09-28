import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { runProcess } from '../shared/child-process/run-process'
import { ORCAD_BUN_VERSION } from '../shared/orcad-bun-runtime'
import { orcadBunRuntimeFilename } from '../shared/orcad-artifacts'

/** Runs real PTY fixtures under the same pinned runtime as the terminal service. */
export async function runBundledBunFixture(
  modulePath: string,
  exportName: string,
  args: unknown,
  timeoutMs: number
): Promise<unknown> {
  const filename = orcadBunRuntimeFilename(process.platform)
  const runtime = [
    process.env.BUN_EXECUTABLE,
    join(process.cwd(), 'out', 'orcad', filename),
    join(process.cwd(), 'out', 'cli-runtime', `${process.platform}-${process.arch}`, filename)
  ].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)))
  if (!runtime) {
    throw new Error('Real terminal tests require the pinned bundled Bun runtime')
  }
  const script = `
    if (process.versions.bun !== ${JSON.stringify(ORCAD_BUN_VERSION)}) throw new Error('Unexpected Bun version');
    const args = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
    const fixture = require(${JSON.stringify(modulePath)});
    Promise.resolve(fixture[${JSON.stringify(exportName)}](args)).then(
      result => process.stdout.write(JSON.stringify(result ?? null)),
      error => { console.error(error); process.exitCode = 1 }
    );
  `
  const env = { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
  for (const key of Object.keys(env)) {
    if (/^(NODE_OPTIONS|NODE_PATH|BUN_OPTIONS|BUN_INSPECT.*)$/i.test(key)) {
      Reflect.deleteProperty(env, key)
    }
  }
  const result = await runProcess({
    program: runtime,
    args: ['-e', script],
    input: JSON.stringify(args),
    env,
    timeoutMs,
    maxOutputBytes: 4 * 1024 * 1024
  })
  if (result.code !== 0 || result.timedOut || result.outputTruncated) {
    throw new Error(`Bun terminal fixture failed: ${result.stderr}`)
  }
  return JSON.parse(result.stdout)
}
