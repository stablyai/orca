import { execFileSync } from 'node:child_process'

// Build in a subprocess because Vitest workers cannot chdir; esbuild’s path comments must stay identical across generator cwds.
export function bundleDigestBuiltFrom(cwd: string, generator: string, member: string): string {
  return execFileSync(
    process.execPath,
    [
      '-e',
      `Promise.all([import('node:crypto'), import(${JSON.stringify(generator)})]).then(` +
        `async ([crypto, generator]) => {` +
        `const { script } = await generator.${member}();` +
        `process.stdout.write(crypto.createHash('sha256').update(script).digest('hex'))` +
        `})`
    ],
    { cwd, encoding: 'utf8' }
  )
}

// Reject machine-specific absolute or escaping paths; one ../ from the pinned mobile root still names repository src/shared.
export function machinePathCommentsIn(script: string): string[] {
  return script
    .split('\n')
    .filter((line) => /^\s*\/\/ (\/|\.\.\/\.\.\/)/.test(line) || line.includes('/Users/'))
}
