import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { loadConfig, credentials, ORCA_REF, CONTROL } from './configuration.mjs'
import { openJournal } from './journal.mjs'
import { Resources, intent } from './resource-lifecycle.mjs'

const config = loadConfig()
const auth = await credentials(config)
const id = process.argv[2] ?? randomUUID()
const journal = openJournal(
  config.stateDirectory,
  id,
  process.argv[2] ? undefined : intent(config, auth, 'base', id)
)
if (journal.value.purpose !== 'base') {
  journal.close()
  throw new Error('Not a base build journal')
}
const resources = new Resources(auth, journal)
console.error(`Base build journal: ${id}`)
try {
  const box = process.argv[2]
    ? await resources.get()
    : await resources.create(config, { timeout: 40 * 60 * 1000, persistent: false })
  if (!box || box.status !== 'running') {
    throw new Error('Build host is not running')
  }
  await resources.inventory(box)
  const mkdir = await box.runCommand({
    cmd: 'mkdir',
    args: ['-p', box.cwd, CONTROL],
    cwd: '/',
    timeoutMs: 10000
  })
  if (mkdir.exitCode !== 0) {
    throw new Error('Could not prepare SDK working directory')
  }
  await box.writeFiles([
    {
      path: `${CONTROL}/remote-bootstrap.sh`,
      mode: 0o700,
      content: readFileSync(new URL('remote-bootstrap.sh', import.meta.url))
    }
  ])
  const cmd = journal.value.commandId
    ? await box.getCommand(journal.value.commandId)
    : await box.runCommand({
        cmd: 'bash',
        cwd: '/vercel',
        detached: true,
        timeoutMs: 35 * 60 * 1000,
        args: [
          '-c',
          'bash /vercel/orca-control/remote-bootstrap.sh >/vercel/orca-control/build.log 2>&1'
        ],
        env: { ORCA_REF }
      })
  resources.save({ phase: 'building', commandId: cmd.cmdId })
  let completed = false
  for (let attempt = 0; attempt < 420; attempt++) {
    let running
    try {
      running = await cmd.wait({ signal: AbortSignal.timeout(5000) })
    } catch (error) {
      if (error.name !== 'TimeoutError' && error.name !== 'AbortError') {
        throw error
      }
      continue
    }
    if (running.exitCode !== null && running.exitCode !== undefined) {
      if (running.exitCode !== 0) {
        throw new Error(
          `Build exited ${running.exitCode}; inspect build.log before reconcile ${id}`
        )
      }
      completed = true
      break
    }
    if (attempt % 12 === 0) {
      console.error('Building pinned Orca runtime; remote log: /vercel/orca-control/build.log')
    }
    await delay(5000)
  }
  if (!completed) {
    throw new Error('Build deadline exceeded')
  }
  const snapshot = await box.snapshot({ expiration: 7 * 24 * 60 * 60 * 1000 })
  resources.save({ phase: 'base-retained', retained: [snapshot.snapshotId] })
  console.log(
    JSON.stringify({
      snapshotId: snapshot.snapshotId,
      expiresAt: snapshot.expiresAt,
      orcaRef: ORCA_REF,
      journalId: id
    })
  )
  await resources.destroy()
} catch (error) {
  console.error(
    error.response ? `Provider request failed (HTTP ${error.response.status})` : error.message
  )
  console.error(`Inspect the bounded build sandbox, then run: node lifecycle.mjs reconcile ${id}`)
  process.exitCode = 1
} finally {
  journal.close()
}
