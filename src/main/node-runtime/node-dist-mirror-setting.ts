/** This computer's Node mirror: the Settings value, else the conventional environment variables. */
import { resolveNodeDistMirror } from '../../shared/node-dist-mirror'

let readMirrorSetting: (() => string | undefined) | null = null

/** Registered once the settings store exists; read on every download, so edits apply at once. */
export function setNodeDistMirrorSettingReader(read: (() => string | undefined) | null): void {
  readMirrorSetting = read
}

export function configuredNodeDistMirror(
  env: Record<string, string | undefined> = process.env
): string | null {
  return resolveNodeDistMirror(readMirrorSetting?.(), env)
}
