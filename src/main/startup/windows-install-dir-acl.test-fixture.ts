import { EventEmitter } from 'node:events'
import type { spawn } from 'node:child_process'

/** Shared icacls doubles for the install-dir DACL probe, repair, and recovery tests. */

export const ORPHAN_PACKAGE_ACE = 'S-1-15-2-999-999-999:(OI)(CI)(RX)'
export const RESTRICTED_PACKAGES_ACE =
  'APPLICATION PACKAGE AUTHORITY\\ALL RESTRICTED APPLICATION PACKAGES:(OI)(CI)(RX)'
/** The Program Files default: present on healthy installs, which launch clean. */
export const ALL_PACKAGES_ACE = 'APPLICATION PACKAGE AUTHORITY\\ALL APPLICATION PACKAGES:(RX)'

export const ENGLISH_BASELINE_ACES = [
  'NT AUTHORITY\\SYSTEM:(I)(OI)(CI)(F)',
  'BUILTIN\\Administrators:(I)(OI)(CI)(F)',
  'awin\\neil:(I)(OI)(CI)(F)'
]
/** fr-FR icacls: no principal the English name check can recognize. */
export const FRENCH_BASELINE_ACES = [
  'AUTORITE NT\\Systeme:(I)(OI)(CI)(F)',
  'BUILTIN\\Administrateurs:(I)(OI)(CI)(F)'
]
export const FRENCH_RESTRICTED_PACKAGES_ACE =
  "AUTORITE DE PACKAGE D'APPLICATION\\TOUS LES PACKAGES D'APPLICATION RESTREINTS:(RX)"

/** Real icacls shape: the echoed path is glued onto the first principal. */
export function icaclsDacl(
  target: string,
  aces: string[],
  baseline: string[] = ENGLISH_BASELINE_ACES
): string {
  const [first, ...rest] = [...aces, ...baseline]
  return [
    `${target} ${first}`,
    ...rest.map((ace) => `                    ${ace}`),
    '',
    'Successfully processed 1 files'
  ].join('\r\n')
}

/** `null` output makes the spawn fail, as an unreadable target does. */
export function fakeIcaclsSpawn(output: (target: string) => string | null): {
  spawnFn: typeof spawn
  calls: { file: string; args: string[] }[]
} {
  const calls: { file: string; args: string[] }[] = []
  const spawnFn = ((file: string, args: string[]) => {
    calls.push({ file, args })
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      kill: () => void
    }
    child.stdout = new EventEmitter()
    child.kill = () => undefined
    const out = output(args[0])
    setImmediate(() => {
      if (out === null) {
        child.emit('error', new Error('ENOENT'))
        return
      }
      child.stdout.emit('data', Buffer.from(out, 'utf-8'))
      child.emit('close', 0)
    })
    return child
  }) as unknown as typeof spawn
  return { spawnFn, calls }
}
