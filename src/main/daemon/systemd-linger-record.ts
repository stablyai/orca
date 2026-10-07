/**
 * The current user's logind linger record. `loginctl enable-linger <user>` touches a file in
 * `/var/lib/systemd/linger/` named by systemd's `cescape()` of the user name, and logind tests that
 * same file (`user_check_linger_file`) both to report `Linger` and to keep the user manager running
 * after the last logout (src/login/logind-dbus.c, src/login/logind-user.c).
 */
import { accessSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'

export function currentUsername(): string | null {
  try {
    return userInfo().username || null
  } catch {
    // No passwd entry for this UID (common in containers).
    return null
  }
}

/** systemd's `cescape()` (src/basic/escape.c): backslash, both quotes and the seven C escapes get a
 *  backslash, and every other byte below 0x20 or from 0x7f up becomes `\ooo` octal. */
const CESCAPE_SEQUENCES = new Map<number, string>([
  [0x07, '\\a'],
  [0x08, '\\b'],
  [0x0c, '\\f'],
  [0x0a, '\\n'],
  [0x0d, '\\r'],
  [0x09, '\\t'],
  [0x0b, '\\v'],
  [0x5c, '\\\\'],
  [0x22, '\\"'],
  [0x27, "\\'"]
])

function lingerRecordName(username: string): string {
  let name = ''
  for (const byte of Buffer.from(username, 'utf8')) {
    const sequence = CESCAPE_SEQUENCES.get(byte)
    if (sequence) {
      name += sequence
    } else if (byte < 0x20 || byte >= 0x7f) {
      name += `\\${byte.toString(8).padStart(3, '0')}`
    } else {
      name += String.fromCharCode(byte)
    }
  }
  return name
}

/** logind's own test: the record exists, or ENOENT means no lingering. Any other error, like an
 *  unreadable linger dir, leaves the answer unknown (`null`). */
export function isLingering(lingerDir: string, username: string): boolean | null {
  try {
    accessSync(join(lingerDir, lingerRecordName(username)))
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? false : null
  }
}
