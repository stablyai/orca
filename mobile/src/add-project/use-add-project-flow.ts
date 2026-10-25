import { useCallback, useEffect, useRef, useState } from 'react'
import {
  hostDirectoryBrowse,
  hostGitAvailabilityRead,
  projectAddRun,
  projectCloneRun,
  projectCreateRun,
  type AddProjectRpcSender
} from './add-project-operations'
import { DEFAULT_PROJECT_PARENT, expandHostHomePath } from './add-project-paths'
import type { AddedProject } from './add-project-reply-schema'

export type AddProjectStep = 'choose' | 'create' | 'clone' | 'existing' | 'added'

// Match the desktop web client's clone budget; large or SSH-backed clones outlast the generic timeout.
const PROJECT_CLONE_TIMEOUT_MS = 10 * 60_000

export function useAddProjectFlow(args: {
  client: AddProjectRpcSender | null
  visible: boolean
  onProjectAdded: (project: AddedProject) => void
}) {
  const { client, visible, onProjectAdded } = args
  const [step, setStep] = useState<AddProjectStep>('choose')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [parent, setParent] = useState(DEFAULT_PROJECT_PARENT)
  const [existingPath, setExistingPath] = useState('')
  const [homeDir, setHomeDir] = useState<string | null>(null)
  const [gitAvailable, setGitAvailable] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [added, setAdded] = useState<AddedProject | null>(null)
  // Each open or host change starts a new attempt; replies for an older one are dropped.
  const attemptRef = useRef(0)
  const onProjectAddedRef = useRef(onProjectAdded)
  useEffect(() => {
    onProjectAddedRef.current = onProjectAdded
  }, [onProjectAdded])

  useEffect(() => {
    attemptRef.current += 1
    if (!visible) {
      return
    }
    setStep('choose')
    setName('')
    setUrl('')
    setParent(DEFAULT_PROJECT_PARENT)
    setExistingPath('')
    setBusy(false)
    setError('')
    setAdded(null)
    if (!client) {
      return
    }
    const attempt = attemptRef.current
    void hostDirectoryBrowse
      .request(client, { path: '~' })
      .then((reply) => {
        if (attempt === attemptRef.current) {
          setHomeDir(hostDirectoryBrowse.interpret(reply).resolvedPath)
        }
      })
      .catch(() => undefined)
    void hostGitAvailabilityRead
      .request(client)
      .then((reply) => {
        const read = hostGitAvailabilityRead.interpret(reply)
        if (attempt === attemptRef.current && read.accepted) {
          setGitAvailable(read.value)
        }
      })
      .catch(() => undefined)
  }, [client, visible])

  const openStep = useCallback((next: AddProjectStep) => {
    setError('')
    setStep(next)
  }, [])

  const run = useCallback(
    async (submit: (client: AddProjectRpcSender) => Promise<AddedProject | string>) => {
      if (!client || busy) {
        return
      }
      const attempt = attemptRef.current
      setBusy(true)
      setError('')
      try {
        const result = await submit(client)
        if (typeof result !== 'string') {
          // Refresh the list even when the sheet closed mid-clone: the host still added the project.
          onProjectAddedRef.current(result)
        }
        if (attempt !== attemptRef.current) {
          return
        }
        if (typeof result === 'string') {
          setError(result)
          return
        }
        setAdded(result)
        setStep('added')
      } catch (caught) {
        if (attempt === attemptRef.current) {
          setError(caught instanceof Error ? caught.message : String(caught))
        }
      } finally {
        if (attempt === attemptRef.current) {
          setBusy(false)
        }
      }
    },
    [busy, client]
  )

  const submitCreate = useCallback(
    () =>
      run(async (target) => {
        const created = projectCreateRun.interpret(
          await projectCreateRun.request(target, {
            parentPath: expandHostHomePath(parent, homeDir),
            name: name.trim(),
            // Without Git the host can still make a plain folder project, as the desktop dialog falls back to.
            kind: gitAvailable ? 'git' : 'folder'
          })
        )
        return created.added ? created.repo : created.error
      }),
    [gitAvailable, homeDir, name, parent, run]
  )

  const submitClone = useCallback(
    () =>
      run(async (target) =>
        projectCloneRun.interpret(
          await projectCloneRun.request(
            target,
            { url: url.trim(), destination: expandHostHomePath(parent, homeDir) },
            { timeoutMs: PROJECT_CLONE_TIMEOUT_MS }
          )
        )
      ),
    [homeDir, parent, run, url]
  )

  const submitExisting = useCallback(
    (kind: 'git' | 'folder') =>
      run(async (target) => {
        // Resolve on the host first: it expands ~ and proves the folder exists before registration.
        const listing = hostDirectoryBrowse.interpret(
          await hostDirectoryBrowse.request(target, { path: existingPath.trim() })
        )
        return projectAddRun.interpret(
          await projectAddRun.request(target, { path: listing.resolvedPath, kind })
        )
      }),
    [existingPath, run]
  )

  return {
    added,
    busy,
    error,
    existingPath,
    gitAvailable,
    name,
    openStep,
    parent,
    setExistingPath,
    setName,
    setParent,
    setUrl,
    step,
    submitClone,
    submitCreate,
    submitExisting,
    url
  }
}

export type AddProjectFlow = ReturnType<typeof useAddProjectFlow>
