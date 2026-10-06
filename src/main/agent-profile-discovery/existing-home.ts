// Canonicalizes an external directory without taking ownership of its contents.
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

export type ExternalProfileHomeValidation =
  | { ok: true; home: string }
  | { ok: false; reason: 'invalid-path' | 'not-directory' | 'unavailable-directory' }

export async function validateExternalProfileHome(
  input: string
): Promise<ExternalProfileHomeValidation> {
  if (
    !isAbsolute(input) ||
    input.length > 4096 ||
    [...input].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  ) {
    return { ok: false, reason: 'invalid-path' }
  }
  try {
    const home = await realpath(input)
    return (await stat(home)).isDirectory()
      ? { ok: true, home }
      : { ok: false, reason: 'not-directory' }
  } catch {
    return { ok: false, reason: 'unavailable-directory' }
  }
}
