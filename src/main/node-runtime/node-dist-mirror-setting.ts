import { resolveNodeDistMirror } from '../../shared/node-dist-mirror'

let readMirrorSetting: (() => string | undefined) | null = null

/** Register after settings initialization; reread on every download so changes apply immediately. */
export function setNodeDistMirrorSettingReader(read: (() => string | undefined) | null): void {
  readMirrorSetting = read
}

export function configuredNodeDistMirror(
  env: Record<string, string | undefined> = process.env
): string | null {
  return resolveNodeDistMirror(readMirrorSetting?.(), env)
}
