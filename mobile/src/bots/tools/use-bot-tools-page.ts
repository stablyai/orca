// A bot's tools as Settings › Tools shows them: the list, then the host's check of every server,
// which starts them, so it runs only while the page is open and stops when it closes. Connectors
// checks only its apps' URL servers, as the desktop's does.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { BotToolProblem } from '../../../../src/shared/bot-tools'
import { isBotAppTool } from '../../../../src/shared/bots/bot-connector-entries'
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

export function useBotToolsPage(
  client: RpcClient | null,
  botId: string,
  scope: 'all' | 'apps' = 'all',
  /** The route's reads: each later one reads the tools again (the host's notices), keeping the check. */
  again?: number
) {
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
      // An app Orca signs in to has its own state, so only the CLI's URL servers are checked.
      const checked =
        scope === 'all' ? own : own.filter((tool) => isBotAppTool(tool) && tool.remote)
      if (!client || checked.length === 0) {
        setProblems({})
        return
      }
      const gen = check.current.generation
      check.current.running = true
      setProblems(null)
      void botToolProblemsRead
        // The host polls the CLI's check for up to 30 s after starting it.
        .request(
          client,
          { botId, scope: scope === 'all' ? 'all' : 'remote' },
          { timeoutMs: 120_000 }
        )
        .then((response) => botToolProblemsRead.interpret(response).problems)
        .catch(() =>
          // Orca's own sign-ins aren't checked, so they never read as unconfirmed.
          Object.fromEntries(
            checked
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
    [client, botId, scope, stopCheck]
  )

  /** Reads the tools again; `recheck` also checks the servers again (a tool was added or edited). */
  // Only the latest read lands; a recheck asked by one it replaced runs on the latest's answer, and
  // a replaced read settles with the latest, so a caller that navigates after it sees fresh tools.
  const lists = useRef({ generation: 0, recheck: false, latest: Promise.resolve() })
  const reread = useCallback(
    (recheck = false): Promise<void> => {
      if (!client) {
        return Promise.resolve()
      }
      const gen = (lists.current.generation += 1)
      lists.current.recheck ||= recheck
      const settled = (async (): Promise<void> => {
        try {
          const read = botToolsListRead.interpret(await botToolsListRead.request(client, { botId }))
          if (gen !== lists.current.generation) {
            return await lists.current.latest
          }
          if (!mounted.current) {
            return
          }
          const next = { own: read.own ?? [], inherited: read.inherited ?? [] }
          setTools(next)
          setError(null)
          if (lists.current.recheck) {
            lists.current.recheck = false
            runCheck(next.own)
          }
        } catch (caught) {
          if (gen !== lists.current.generation) {
            return lists.current.latest
          }
          setError(caught instanceof Error ? caught.message : String(caught))
        }
      })()
      lists.current.latest = settled
      return settled
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

  const firstAgain = useRef(again)
  useEffect(() => {
    if (again !== firstAgain.current) {
      void reread()
    }
  }, [again, reread])

  return {
    tools,
    error,
    problems,
    reread,
    checkAgain: () => tools && runCheck(tools.own)
  }
}
