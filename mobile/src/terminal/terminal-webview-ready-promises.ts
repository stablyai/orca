import { useMemo } from 'react'

// Wait for init’s ready after render/layout so follow-up fitting reads that init’s measured box; bound silence with a timeout.

const READY_TIMEOUT_MS = 3000
const PROMPT_BACKLOAD_TIMEOUT_MS = 250

export function createTerminalWebViewReadyPromises() {
  let readyPromise: Promise<void> | null = null
  let readyResolve: (() => void) | null = null
  let promptResolve: ((text: string) => void) | null = null

  // Resolve superseded waiters before rearming so rapid re-init cannot pin fit chains until their old timeout.
  function armReady() {
    const priorResolve = readyResolve
    readyResolve = null
    readyPromise = null
    priorResolve?.()
    readyPromise = new Promise<void>((resolve) => {
      readyResolve = resolve
    })
  }

  function resolveReady() {
    const resolve = readyResolve
    readyResolve = null
    readyPromise = null
    resolve?.()
  }

  async function awaitReady(): Promise<void> {
    const pending = readyPromise
    if (!pending) {
      return
    }
    await new Promise<void>((resolve) => {
      let settled = false
      const timeout = setTimeout(() => {
        settled = true
        resolve()
      }, READY_TIMEOUT_MS)
      void pending.finally(() => {
        if (!settled) {
          clearTimeout(timeout)
          settled = true
          resolve()
        }
      })
    })
  }

  function resolvePromptBackload(value: unknown) {
    const resolve = promptResolve
    promptResolve = null
    resolve?.(typeof value === 'string' ? value : '')
  }

  function awaitPromptBackload(request: () => void): Promise<string> {
    const prior = promptResolve
    promptResolve = null
    prior?.('')
    return new Promise<string>((resolve) => {
      let settled = false
      const finish = (text: string) => {
        if (!settled) {
          settled = true
          clearTimeout(timeout)
          resolve(text)
        }
      }
      const timeout = setTimeout(() => {
        if (promptResolve === finish) {
          promptResolve = null
        }
        finish('')
      }, PROMPT_BACKLOAD_TIMEOUT_MS)
      promptResolve = finish
      request()
    })
  }

  return { armReady, awaitPromptBackload, awaitReady, resolvePromptBackload, resolveReady }
}

export function useTerminalWebViewReadyPromises() {
  return useMemo(() => createTerminalWebViewReadyPromises(), [])
}
