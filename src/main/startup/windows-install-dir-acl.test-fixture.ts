import { EventEmitter } from 'node:events'
import { writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import type { spawn } from 'node:child_process'

/**
 * Shared icacls doubles for the install-dir DACL probe, repair, and recovery tests.
 * ACEs are SDDL, the shape `icacls <target> /save <file>` writes (captured on
 * win32 10.0.26200: the leaf name, CRLF, then `D:AI(...)(...)`, UTF-16LE).
 */

export const ORPHAN_PACKAGE_ACE = '(A;OICI;0x1200a9;;;S-1-15-2-999-999-999)'
/** ALL RESTRICTED APPLICATION PACKAGES; SDDL has no alias for it. */
export const RESTRICTED_PACKAGES_ACE = '(A;OICI;0x1200a9;;;S-1-15-2-2)'
/** ALL APPLICATION PACKAGES (`AC`), the Program Files default: healthy installs launch clean. */
export const ALL_PACKAGES_ACE = '(A;;0x1200a9;;;AC)'

export const BASELINE_ACES = [
  '(A;OICIID;FA;;;SY)',
  '(A;OICIID;FA;;;BA)',
  '(A;OICIID;FA;;;S-1-5-21-432636774-4279371817-3971399515-1001)'
]

/** The file `icacls <target> /save` writes for a target carrying these ACEs. */
export function icaclsSavedAcl(target: string, aces: string[]): Buffer {
  const leaf = basename(target.replaceAll('\\', '/'))
  return Buffer.from(`${leaf}\r\nD:AI${[...aces, ...BASELINE_ACES].join('')}\r\n`, 'utf16le')
}

/**
 * `saved` returns the target's extra ACEs, or the raw saved file; `null` makes the
 * spawn fail, as an unreadable target does. `display` is what a bare
 * `icacls <target>` prints.
 */
export function fakeIcaclsSpawn(
  saved: (target: string) => string[] | Buffer | null,
  display: (target: string) => string = () => '',
  exitCode: number | null = 0
): {
  spawnFn: typeof spawn
  calls: { file: string; args: string[] }[]
} {
  const calls: { file: string; args: string[] }[] = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double; the probe only touches kill/stdout/on of the child.
  const spawnFn = ((file: string, args: string[]) => {
    calls.push({ file, args })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: both fields are assigned on the next two lines.
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      kill: () => void
    }
    child.stdout = new EventEmitter()
    child.kill = () => undefined
    const [target, verb, saveFile] = args
    const aces = saved(target)
    setImmediate(() => {
      if (aces === null) {
        child.emit('error', new Error('ENOENT'))
        return
      }
      if (verb === '/save') {
        writeFileSync(saveFile, Buffer.isBuffer(aces) ? aces : icaclsSavedAcl(target, aces))
      } else {
        child.stdout.emit('data', Buffer.from(display(target), 'utf-8'))
      }
      child.emit('close', exitCode)
    })
    return child
  }) as unknown as typeof spawn
  return { spawnFn, calls }
}
