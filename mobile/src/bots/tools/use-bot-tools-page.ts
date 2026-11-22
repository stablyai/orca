// A bot's tools as Settings › Tools shows them: the list, then the host's check of every server,
// which starts them, so it runs only while the page is open and stops when it closes.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { BotToolProblem } from '../../../../src/shared/bot-tools'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import {
  botToolProblemsCancel,
  botToolProblemsRead,
  botToolsListRead,
  type PhoneOwnTool
} from './bot-tool-operations'

export type PhoneBotTools = {
  own: PhoneOwnTool[]
  inherited: { name: string; plugin?: true }[]
}

const UNFINISHED = 'The native check did not finish. Check again to retry.'

export function useBotToolsPage(client: RpcClient | null, botId: string) {
  const [tools, setTools] = useState<PhoneBotTools | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Null while the check runs. */
  const [problems, setProblems] = useState<Record<string, BotToolProblem> | null>(null)
  const check = useRef({ generation: 0, running: false })
  // A read answering after the page closed must not start a check nobody will stop.
  const mounted = useRef(false)

  const stopCheck = useCallback(() => {
    check.current.generation += 1
    if (check.current.running && client) {
      void botToolProblemsCancel.request(client, { botId }).catch(() => {})
    }
    check.current.running = false
  }, [client, botId])

  const runCheck = useCallback(
    (own: readonly PhoneOwnTool[]) => {
      stopCheck()
      if (!client || own.length === 0) {
        setProblems({})
        return
      }
      const gen = check.current.generation
      check.current.running = true
      setProblems(null)
      void botToolProblemsRead
        // The host polls the CLI's check for up to 30 s after starting it.
        .request(client, { botId, scope: 'all' }, { timeoutMs: 120_000 })
        .then((response) => botToolProblemsRead.interpret(response).problems)
        .catch(() =>
          // Orca's own sign-ins aren't checked, so they never read as unconfirmed.
          Object.fromEntries(
            own
              .filter((tool) => !tool.signIn)
              .map((tool) => [tool.name, { kind: 'unconfirmed' as const, detail: UNFINISHED }])
          )
        )
        .then((found) => {
          if (gen === check.current.generation) {
            check.current.running = false
            setProblems(found)
          }
        })
    },
    [client, botId, stopCheck]
  )

  /** Reads the tools again; `recheck` also checks the servers again (a tool was added or edited). */
  const reread = useCallback(
    async (recheck = false) => {
      if (!client) {
        return
      }
      try {
        const read = botToolsListRead.interpret(await botToolsListRead.request(client, { botId }))
        if (!mounted.current) {
          return
        }
        const next = { own: read.own ?? [], inherited: read.inherited ?? [] }
        setTools(next)
        setError(null)
        if (recheck) {
          runCheck(next.own)
        }
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    },
    [client, botId, runCheck]
  )

  useEffect(() => {
    mounted.current = true
    void reread(true)
    return () => {
      mounted.current = false
      stopCheck()
    }
  }, [reread, stopCheck])

  return {
    tools,
    error,
    problems,
    reread,
    checkAgain: () => tools && runCheck(tools.own)
  }
}
