// SANDBOX-CONTROL-TYPECHECK: `pnpm typecheck` for this Worker. tsc checks every file the program reaches, and
// the Worker imports desktop code from src/shared (wire types, parsers). Those files are written for the
// desktop's compiler options (no noUncheckedIndexedAccess) and globals (window, MessageChannel), and the
// desktop's own typecheck covers them; TypeScript has no per-file options. So this fails on any diagnostic in
// this package's own files, or one tsc reports without a file (a config error), and counts the rest.
//   node scripts/typecheck.mjs
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

/** Splits tsc --pretty false output into this package's diagnostics (with their detail lines) and a count of others. */
export function splitDiagnostics(output) {
  const own = []
  let foreign = 0
  let keep = false
  for (const line of output.split('\n')) {
    const located = /^(.+?)\(\d+,\d+\): error TS\d+/.exec(line)
    if (located) {
      // Paths are relative to this package: anything reached through `..` is not its own.
      keep = !located[1].startsWith('..') && !located[1].startsWith('/')
      if (keep) {
        own.push(line)
      } else {
        foreign++
      }
    } else if (/^error TS\d+/.test(line)) {
      keep = true
      own.push(line)
    } else if (keep && line.startsWith(' ') && line.trim()) {
      own.push(line)
    } else if (line.trim()) {
      keep = false
    }
  }
  return { own, foreign }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc')
  const run = spawnSync(process.execPath, [tsc, '--noEmit', '-p', '.', '--pretty', 'false'], { encoding: 'utf8' })
  const { own, foreign } = splitDiagnostics(`${run.stdout ?? ''}${run.stderr ?? ''}`)
  if (own.length > 0) {
    process.stdout.write(`${own.join('\n')}\n`)
  }
  if (foreign > 0) {
    process.stdout.write(`(${foreign} diagnostics in imported desktop files: checked by the desktop typecheck, not here)\n`)
  }
  const ownErrors = own.filter((line) => / error TS\d+/.test(line) || /^error TS\d+/.test(line)).length
  process.stdout.write(`sandbox-control typecheck: ${ownErrors} error(s) in its own files\n`)
  // A crash, or a non-zero exit with nothing parsed, is never a pass.
  process.exit(ownErrors > 0 || run.status === null || (run.status !== 0 && foreign === 0) ? 1 : 0)
}
