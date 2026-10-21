import { execFileSync } from 'node:child_process'

/**
 * A WebView document bundle, built from somewhere else entirely, as a digest.
 *
 * esbuild writes each module's path into the bundle as a comment, relative to the working
 * directory, so the artifact's bytes depend on where its generator ran unless the generator pins
 * `absWorkingDir`. Three cwds gave three digests before it was pinned, and from outside the repo
 * the comments carried an absolute path with the builder's home directory in it — which is a
 * machine path in a file every test compares against the committed artifact.
 *
 * In a child process because that is the only way to ask the question: a vitest worker cannot
 * change its own working directory, so a case run from `mobile/` can only see the one answer.
 */
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

/**
 * Every line of a bundle that names a directory only the machine that built it has.
 *
 * Both shapes esbuild can emit when the working directory is not the one the sources live under: a
 * comment that is an absolute path, and one that climbs out with `../`.
 */
export function machinePathCommentsIn(script: string): string[] {
  return script
    .split('\n')
    .filter((line) => /^\s*\/\/ (\/|\.\.\/)/.test(line) || line.includes('/Users/'))
}
