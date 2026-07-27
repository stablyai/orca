#!/usr/bin/env node
/**
 * Select the E2E spec files a pull request changed.
 *
 * Reads the PR's changed-file list (one path per line) on stdin and writes the
 * subset that the headless Playwright suite can run, one path per line, on
 * stdout. The e2e-changed-specs workflow feeds the result straight to
 * `pnpm run test:e2e`, so this is the boundary where PR-controlled filenames
 * stop being arbitrary text.
 *
 * Why a strict allowlist rather than a suffix check: a fork PR chooses its own
 * filenames, and the selected paths become argv for a shell-invoked command.
 * Anything outside `tests/e2e/`, containing a shell metacharacter, or walking
 * upward is dropped rather than escaped.
 */

/** Only plain paths directly under tests/e2e/ (nested dirs allowed). */
const SPEC_PATH = /^tests\/e2e\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.spec\.ts$/

export function selectChangedE2eSpecs(changedFiles) {
  const selected = changedFiles
    .map((line) => line.trim())
    .filter((path) => SPEC_PATH.test(path))
    // Why: `.` and `..` are legal filename characters for the pattern above,
    // so reject traversal explicitly instead of trusting the character class.
    .filter((path) => !path.split('/').includes('..'))
  return [...new Set(selected)].sort()
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

// Why: importing this module from the unit test must not consume stdin.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const input = await readStdin()
  const specs = selectChangedE2eSpecs(input.split('\n'))
  process.stdout.write(specs.length ? `${specs.join('\n')}\n` : '')
}
