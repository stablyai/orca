import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type GhApiJsonInputArgs = readonly ['--input', string]

/**
 * Send a `gh api` request body from a temp JSON file via `--input`.
 *
 * Why: `--raw-field body=` puts the payload on argv, which exceeds Windows
 * CreateProcess 32767 (ENAMETOOLONG) for pasted screenshot data-URIs.
 * `ghExecFileAsync` does not forward stdin, so `--input -` cannot be used.
 */
export async function withGhApiJsonInput<T>(
  payload: Record<string, unknown>,
  run: (inputArgs: GhApiJsonInputArgs) => Promise<T>
): Promise<T> {
  const tempDir = await mkdtemp(join(tmpdir(), 'orca-gh-api-json-'))
  const inputPath = join(tempDir, 'input.json')
  try {
    await writeFile(inputPath, JSON.stringify(payload), 'utf8')
    return await run(['--input', inputPath])
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }
}
