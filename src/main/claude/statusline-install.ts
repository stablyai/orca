import { homedir } from 'node:os'
import { parseHooksJsonText } from '../agent-hooks/hooks-json-read'
import { lstat, rm } from 'node:fs/promises'
import { writeManagedScript, type HooksConfig } from '../agent-hooks/installer-utils'
import {
  writeHooksJsonAsync,
  type NativeHookDestination
} from '../agent-hooks/hooks-json-write-async'
import { getManagedStatusLineCommand, getManagedStatusLineScript } from './statusline-script'
import {
  applyManagedStatusLine,
  CLAUDE_HOOK_SETTINGS,
  getConfigPath,
  getStatusLineInstallMarkerPath,
  getStatusLineScriptFileName,
  getStatusLineScriptPath,
  getStatusLineSlotState,
  removeManagedStatusLine,
  removeManagedHooks,
  getManagedScriptFileName
} from './hook-settings'
import {
  readSystemHookSettings,
  readStatusLineEvidence,
  selectedStatusLineDestination,
  existingStatusLineDestination,
  sameStatusLineDestination,
  withClaudeSystemScope,
  requestClaudeSystemOperation,
  type SystemOperation
} from './statusline-ownership'
import type { ClaudeManagedHookPlan } from './claude-managed-hook-events'

function parseCurrent(raw: string | null): HooksConfig {
  const config = raw === null ? {} : parseHooksJsonText(raw)
  if (!config) {
    throw new Error('Could not parse current Claude settings.json')
  }
  return config
}

const changed = (current: HooksConfig, next: HooksConfig) =>
  JSON.stringify(current) === JSON.stringify(next) ? null : next

export async function installClaudeSystemHooks(
  path: string,
  plan: ClaudeManagedHookPlan,
  mergeEvents: (config: HooksConfig) => HooksConfig,
  options: SystemOperation = {}
) {
  const home = homedir()
  const invocation = requestClaudeSystemOperation(home, options)
  const admission = AbortSignal.any([invocation.signal, AbortSignal.timeout(2000)])
  try {
    await withClaudeSystemScope(
      home,
      admission,
      async (ownership) => {
        let initial: { raw: string | null; config: HooksConfig } = { raw: null, config: {} }
        const selectedPath = await writeHooksJsonAsync(
          path,
          {},
          {
            updateConfig: (raw) => {
              invocation.check()
              initial = { raw, config: parseCurrent(raw) }
              return raw === null ? null : changed(initial.config, mergeEvents(initial.config))
            },
            beforePublish: async () => invocation.check()
          }
        )
        if (getStatusLineSlotState(initial.config) === 'user') {
          return
        }
        const scriptPath = getStatusLineScriptPath()
        if (plan.statusLine === 'install') {
          writeManagedScript(scriptPath, getManagedStatusLineScript('local'))
        }
        const command = getManagedStatusLineCommand(scriptPath)
        const prepared: { store?: ReturnType<typeof ownership> } = {}
        let destination!: NativeHookDestination
        let priorManaged = false
        let journaled = false
        let publishedManaged = false
        let protectDeletion = false
        await writeHooksJsonAsync(
          selectedPath ?? path,
          {},
          {
            prepare: async (selected) => {
              if (selectedPath === null) {
                initial = await readSystemHookSettings(selected)
                if (getStatusLineSlotState(initial.config) === 'user') {
                  return
                }
              }
              const store = ownership()
              prepared.store = store
              destination = await readStatusLineEvidence(admission, async () => {
                await store.read()
                return await selectedStatusLineDestination(selected)
              })
              invocation.check()
              const owner = store.document.destinations.find((entry) =>
                sameStatusLineDestination(entry, destination)
              )
              priorManaged = owner?.phase === 'managed'
              if (
                (initial.raw === null && priorManaged) ||
                (plan.statusLine === 'retire' &&
                  getStatusLineSlotState(initial.config) === 'managed')
              ) {
                await store.set(destination, 'own-change')
                journaled = true
                const actual = await readStatusLineEvidence(admission, () =>
                  selectedStatusLineDestination(selected)
                )
                if (!sameStatusLineDestination(destination, actual)) {
                  throw new Error('Claude settings destination changed')
                }
              }
              invocation.check()
            },
            updateConfig: (raw) => {
              invocation.check()
              const config = parseCurrent(raw)
              const slot = getStatusLineSlotState(config)
              if (raw === null && priorManaged && !journaled) {
                throw new Error('Claude settings disappeared before recreation was prepared')
              }
              protectDeletion =
                raw !== null && slot === 'empty' && priorManaged && initial.raw !== null
              let next = mergeEvents(config)
              if (slot !== 'user' && !protectDeletion) {
                if (plan.statusLine === 'install') {
                  next = applyManagedStatusLine(next, command, getStatusLineScriptFileName())
                  publishedManaged = true
                } else if (plan.statusLine === 'retire' && slot === 'managed') {
                  if (!journaled) {
                    throw new Error('Claude callback changed before retirement was prepared')
                  }
                  next = removeManagedStatusLine(next, getStatusLineScriptFileName()).config
                }
              }
              return changed(config, next)
            },
            beforePublish: async () => invocation.check()
          }
        )
        const store = prepared.store
        if (!store) {
          return
        }
        if (publishedManaged) {
          // Admitted publication and its receipt stay joined through real completion.
          const published = await selectedStatusLineDestination(destination.path)
          if ((await lstat(published.path)).isSymbolicLink()) {
            throw new Error('Claude callback destination changed after publication')
          }
          const verified = await readSystemHookSettings(published.path)
          if (
            !sameStatusLineDestination(destination, published) ||
            getStatusLineSlotState(verified.config) !== 'managed'
          ) {
            throw new Error('Claude callback publication could not be verified')
          }
          await store.set(published, 'managed')
        } else if (journaled && protectDeletion) {
          // A completed user deletion during preparation is not our unpublication.
          await store.set(destination, 'managed')
        } else {
          const owner = store.document.destinations.find((entry) =>
            sameStatusLineDestination(entry, destination)
          )
          if (owner?.phase === 'own-change') {
            await store.set(destination)
          }
        }
      },
      invocation.check
    )
  } finally {
    invocation.finish()
  }
}

export async function removeClaudeSystemHooks(path: string, options: SystemOperation = {}) {
  const home = homedir()
  const invocation = requestClaudeSystemOperation(home, options)
  const admission = AbortSignal.any([invocation.signal, AbortSignal.timeout(2000)])
  try {
    await withClaudeSystemScope(
      home,
      admission,
      async (ownership) => {
        const errors: string[] = []
        const targets = new Set([path, getConfigPath(CLAUDE_HOOK_SETTINGS)])
        const selectedTargets = new Set<string>()
        // Event teardown is independent of optional callback authority at both known targets.
        for (const target of targets) {
          try {
            invocation.check()
            const selected = await writeHooksJsonAsync(
              target,
              {},
              {
                updateConfig: (raw) => {
                  invocation.check()
                  if (raw === null) {
                    return null
                  }
                  const events = removeManagedHooks(parseCurrent(raw), getManagedScriptFileName())
                  return events.changed ? events.config : null
                },
                beforePublish: async () => invocation.check()
              }
            )
            if (selected) {
              selectedTargets.add(selected)
            }
          } catch (error) {
            errors.push(String(error))
          }
        }
        try {
          const store = ownership()
          const destinations: NativeHookDestination[] = []
          await readStatusLineEvidence(admission, async () => {
            await store.read()
            for (const target of selectedTargets) {
              try {
                const selected = await existingStatusLineDestination(target)
                if (selected) {
                  destinations.push(selected)
                }
              } catch (error) {
                errors.push(String(error))
              }
            }
          })
          invocation.check()
          await store.save(
            store.document.destinations.filter(
              (owner) =>
                !destinations.some((selected) => sameStatusLineDestination(owner, selected))
            ),
            true
          )
          for (const selected of destinations) {
            try {
              invocation.check()
              await writeHooksJsonAsync(
                selected.path,
                {},
                {
                  prepare: async (writePath) => {
                    const actual = await readStatusLineEvidence(admission, () =>
                      selectedStatusLineDestination(writePath)
                    )
                    if (!sameStatusLineDestination(selected, actual)) {
                      throw new Error('Claude settings destination changed')
                    }
                    invocation.check()
                  },
                  updateConfig: (raw) => {
                    invocation.check()
                    if (raw === null) {
                      return null
                    }
                    const events = removeManagedHooks(parseCurrent(raw), getManagedScriptFileName())
                    const callback = removeManagedStatusLine(
                      events.config,
                      getStatusLineScriptFileName()
                    )
                    return events.changed || callback.changed ? callback.config : null
                  },
                  beforePublish: async () => invocation.check()
                }
              )
            } catch (error) {
              errors.push(String(error))
            }
          }
        } catch (error) {
          errors.push(String(error))
        }
        invocation.check()
        await rm(getStatusLineInstallMarkerPath(), { force: true }).catch((error: unknown) =>
          errors.push(String(error))
        )
        if (errors.length) {
          throw new Error(errors.join('; '))
        }
      },
      invocation.check
    )
  } finally {
    invocation.finish()
  }
}
