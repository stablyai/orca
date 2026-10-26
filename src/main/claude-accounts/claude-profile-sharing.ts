import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync
} from 'node:fs'
import { dirname } from 'node:path'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import type { ClaudeProfileSurfaceOutcome } from './claude-profile-report'

export function linkClaudeProfileDirectory(
  source: string,
  target: string,
  platform: NodeJS.Platform
): ClaudeProfileSurfaceOutcome {
  let canonical: string
  try {
    canonical = realpathSync(source)
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return 'absent'
    }
    throw error
  }
  let entry: ReturnType<typeof lstatSync> | undefined
  try {
    entry = lstatSync(target)
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      throw error
    }
  }
  if (entry?.isSymbolicLink()) {
    try {
      return realpathSync(target) === canonical ? 'unchanged' : 'user-owned'
    } catch (error) {
      if (!isDefinitiveAbsence(error)) {
        throw error
      }
      unlinkSync(target)
    }
  } else if (entry) {
    if (!entry.isDirectory() || readdirSync(target).length > 0) {
      return 'user-owned'
    }
    rmdirSync(target)
  }
  mkdirSync(dirname(target), { recursive: true })
  // Link the source path so later user symlink changes are followed.
  symlinkSync(source, target, platform === 'win32' ? 'junction' : 'dir')
  return 'linked'
}

/** Copy files because rename-replace saves break links. */
export function copyClaudeProfileFile(
  source: string,
  target: string,
  render: (sourceText: Buffer) => Buffer = (sourceText) => sourceText
): ClaudeProfileSurfaceOutcome {
  let desired: Buffer
  let mode: number
  try {
    desired = render(readFileSync(source))
    mode = statSync(source).mode & 0o777
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return 'absent'
    }
    throw error
  }
  try {
    if (lstatSync(target).isSymbolicLink()) {
      return 'user-owned'
    }
    if (readFileSync(target).equals(desired)) {
      return 'unchanged'
    }
  } catch (error) {
    if (!isDefinitiveAbsence(error)) {
      throw error
    }
  }
  writeFileAtomically(target, desired, { mode })
  return 'synced'
}
