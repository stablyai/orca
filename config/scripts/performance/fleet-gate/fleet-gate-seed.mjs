// Turns a real profile's state databases into a fleet seed that a test copy can open without side effects.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const PROFILE_ID = 'local-default'

// Domains that would make a test copy reach real hosts or run agents on a schedule.
const NEUTRALIZED_DOMAINS = [
  'sshTargets',
  'sshRemotePtyLeases',
  'sshPtyConsumerRecoveries',
  'automations',
  'bots'
]

function seedProfileDatabase(seedDir) {
  return path.join(seedDir, 'profiles', PROFILE_ID, 'profile-state.db')
}

export async function prepareFleetSeed(sourceDir, seedDir) {
  const { DatabaseSync } = await import('node:sqlite')
  const profileSource = path.join(sourceDir, 'profile-state.db')
  const chatSource = path.join(sourceDir, 'agent-session-domain.db')
  for (const file of [profileSource, chatSource]) {
    if (!fs.existsSync(file)) {
      throw new Error(`seed source is missing ${file}`)
    }
  }
  fs.rmSync(seedDir, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(seedProfileDatabase(seedDir)), { recursive: true })
  // VACUUM INTO writes a consistent copy even if the source has a live WAL.
  for (const [from, to] of [
    [profileSource, seedProfileDatabase(seedDir)],
    [chatSource, path.join(seedDir, 'agent-session-domain.db')]
  ]) {
    const source = new DatabaseSync(from, { readOnly: true })
    source.exec(`VACUUM INTO '${to.replaceAll("'", "''")}'`)
    source.close()
  }
  const db = new DatabaseSync(seedProfileDatabase(seedDir))
  const update = db.prepare(
    'UPDATE profile_state_documents SET payload = ?, content_hash = ? WHERE domain = ?'
  )
  const emptyList = '[]'
  const hash = createHash('sha256').update(emptyList, 'utf8').digest('hex')
  const neutralized = []
  for (const domain of NEUTRALIZED_DOMAINS) {
    if (update.run(emptyList, hash, domain).changes > 0) {
      neutralized.push(domain)
    }
  }
  db.close()
  return { seedDir, neutralized, census: await describeFleetSeed(seedDir) }
}

export async function describeFleetSeed(seedDir) {
  const { DatabaseSync } = await import('node:sqlite')
  const chat = new DatabaseSync(path.join(seedDir, 'agent-session-domain.db'), { readOnly: true })
  const count = (table) => {
    try {
      return chat.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
    } catch {
      return null
    }
  }
  const census = {
    chatRecords: count('agent_session_records'),
    chatTabs: count('agent_session_tabs')
  }
  chat.close()
  return census
}

export function assertFleetSeed(seedDir) {
  for (const file of [
    seedProfileDatabase(seedDir),
    path.join(seedDir, 'agent-session-domain.db')
  ]) {
    if (!fs.existsSync(file)) {
      throw new Error(
        `fleet seed ${seedDir} is missing ${path.relative(seedDir, file)}; build one with --prepare-seed <dir with profile-state.db and agent-session-domain.db>`
      )
    }
  }
}

/** Copy-on-write clone where the filesystem supports it (APFS, btrfs, XFS); a plain copy otherwise. */
export function cloneFleetSeed(seedDir, userDataDir) {
  fs.rmSync(userDataDir, { recursive: true, force: true })
  fs.cpSync(seedDir, userDataDir, { recursive: true, mode: fs.constants.COPYFILE_FICLONE })
}
