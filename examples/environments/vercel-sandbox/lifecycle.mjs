import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { loadConfig, credentials } from './configuration.mjs'
import { openJournal } from './journal.mjs'
import { Resources, intent } from './resource-lifecycle.mjs'
import { initializeProject, serve, startupDiagnostics } from './remote-runtime.mjs'

export async function readPayload(stream, mode) {
  let text = ''
  for await (const chunk of stream) {
    text += chunk
    if (Buffer.byteLength(text) > 1024 * 1024) {
      throw new Error('Lifecycle payload exceeds 1 MiB')
    }
  }
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error('Invalid lifecycle JSON')
  }
  const data = payload.recipeResult?.userData
  if (
    payload.schemaVersion !== 1 ||
    payload.mode !== mode ||
    data?.provider !== 'vercel-sandbox' ||
    typeof data.resourceId !== 'string' ||
    typeof data.owner !== 'string' ||
    typeof data.journalId !== 'string'
  ) {
    throw new Error('Invalid lifecycle payload')
  }
  return data
}
export function verifyPayload(data, state) {
  if (
    data.resourceId !== state.name ||
    data.owner !== state.owner ||
    data.journalId !== state.id ||
    state.purpose !== 'workspace'
  ) {
    throw new Error('Lifecycle payload does not match the local ownership journal')
  }
}
export async function main(mode, id) {
  if (!['create', 'suspend', 'resume', 'destroy', 'reconcile'].includes(mode)) {
    throw new Error('Expected create, suspend, resume, destroy or reconcile <journal-id>')
  }
  const config = loadConfig()
  const auth = await credentials(config)
  const data =
    mode === 'create' || mode === 'reconcile' ? null : await readPayload(process.stdin, mode)
  if (mode === 'create' && (!config.snapshotId || !config.repoUrl || !config.repoRef)) {
    throw new Error('Configure snapshotId, repoUrl and repoRef first')
  }
  const journalId = mode === 'create' ? randomUUID() : (data?.journalId ?? id)
  const journal = openJournal(
    config.stateDirectory,
    journalId,
    mode === 'create' ? intent(config, auth, 'workspace', journalId) : undefined
  )
  try {
    if (data) {
      verifyPayload(data, journal.value)
    }
    const resources = new Resources(auth, journal)
    if (mode === 'create') {
      console.error(`Resource journal: ${journalId}`)
      let box
      try {
        box = await resources.create(config)
        await initializeProject(box, config, journal.value.owner)
        const recipe = await serve(box, journal.value.owner)
        resources.save({ phase: 'ready' })
        return result(recipe, journal.value)
      } catch (error) {
        if (box) {
          try {
            resources.save({
              startupDiagnostics: [await startupDiagnostics(box), error.startupDiagnostics]
                .filter(Boolean)
                .join('\n')
            })
          } catch {
            resources.save({ startupDiagnostics: 'Diagnostic collection failed before cleanup' })
          }
        }
        try {
          await resources.destroy()
        } catch {
          console.error(`Cleanup incomplete. Run reconcile ${journalId}`)
        }
        if (box) {
          console.error(`Sanitized diagnostics saved in journal ${journalId}`)
        }
        throw error
      }
    }
    if (mode === 'suspend') {
      await resources.suspend()
    } else if (mode === 'resume') {
      const box = await resources.resume()
      let recipe
      try {
        recipe = await serve(box, journal.value.owner)
      } catch (error) {
        resources.save({
          startupDiagnostics: error.startupDiagnostics ?? (await startupDiagnostics(box))
        })
        throw error
      }
      resources.save({ phase: 'ready' })
      return result(recipe, journal.value)
    } else {
      await resources.destroy()
    }
    return { ok: true, phase: journal.value.phase }
  } catch (error) {
    journal.save({
      ...journal.value,
      lastError: {
        mode,
        at: new Date().toISOString(),
        message: error.response ? `Vercel HTTP ${error.response.status}` : error.message
      }
    })
    throw error
  } finally {
    journal.close()
  }
}
function result(recipe, state) {
  return {
    ...recipe,
    schemaVersion: 1,
    userData: {
      provider: 'vercel-sandbox',
      resourceId: state.name,
      owner: state.owner,
      journalId: state.id
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2], process.argv[3])
    .then((value) => console.log(JSON.stringify(value)))
    .catch((error) => {
      // SDK errors can include request bodies; never serialize them into Orca's transcript.
      console.error(
        error.response
          ? `Vercel request failed (HTTP ${error.response.status}); inspect the journal and provider dashboard`
          : error.message
      )
      process.exitCode = 1
    })
}
