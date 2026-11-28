// Mobile hook for loading an ask-backup failover offer and triggering manual switch on a cut turn.
import { useCallback, useEffect, useState } from 'react'
import type { BotBackupModelEntry } from '../../../../../src/shared/bots/bot-backup-models'
import { folderWorkspaceKey } from '../../../../../src/shared/workspace/identity/workspace-scope'
import { botsListRead } from '../../../bots/host-bots-operations'
import { botBackupStatusRead, botBackupSwitch } from '../../../bots/bot-sheet-operations'
import { botAgentLabel } from '../../../bots/mobile-bot-sheet-copy'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'

type BackupOffer = {
  turnItemId: string
  botId: string
  target: BotBackupModelEntry
}

export function useMobileBotBackupUsageLimit(input: {
  live: boolean
  client: RpcClient | null
  sessionId: string | null
  sourceIdentity: string | undefined
  turnItemId: string | null
  backupState: 'switching' | 'ask-backup' | 'backups-exhausted' | undefined
}) {
  const { live, client, sessionId, sourceIdentity, turnItemId, backupState } = input
  const [backupOffer, setBackupOffer] = useState<BackupOffer | null>(null)
  const [backupSwitchingCut, setBackupSwitchingCut] = useState<string | null>(null)
  const [backupSwitchFailedCut, setBackupSwitchFailedCut] = useState<string | null>(null)
  const [backupContinueFailedCut, setBackupContinueFailedCut] = useState<string | null>(null)

  useEffect(() => {
    if (!live || !client || !sessionId || !turnItemId || backupState !== 'ask-backup') {
      return
    }
    let current = true
    void (async () => {
      try {
        const listed = botsListRead.interpret(await botsListRead.request(client))
        if (!current) {
          return
        }
        const matched = listed.accepted
          ? listed.value.bots.find(
              (bot) =>
                bot.chatSessionId === sessionId ||
                (sourceIdentity !== undefined &&
                  sourceIdentity.endsWith(
                    `,${JSON.stringify(folderWorkspaceKey(bot.folderWorkspaceId))}]`
                  ))
            )
          : undefined
        if (!matched) {
          setBackupOffer(null)
          return
        }
        const status = botBackupStatusRead.interpret(
          await botBackupStatusRead.request(
            client,
            { botId: matched.id },
            { failWhenDisconnected: true }
          )
        )
        const ready = status.entries.find((entry) => entry.state === 'ready')?.entry
        if (current) {
          setBackupOffer(ready ? { turnItemId, botId: matched.id, target: ready } : null)
        }
      } catch {
        if (current) {
          setBackupOffer(null)
        }
      }
    })()
    return () => {
      current = false
    }
  }, [live, client, sessionId, turnItemId, backupState, sourceIdentity])

  const activeOffer =
    backupState === 'ask-backup' && backupOffer?.turnItemId === turnItemId ? backupOffer : null
  const backupSwitching = backupSwitchingCut !== null && backupSwitchingCut === turnItemId
  const switchToBackup = useCallback(() => {
    if (!client || !sessionId || !activeOffer || backupSwitching) {
      return
    }
    const cutId = activeOffer.turnItemId
    setBackupSwitchingCut(cutId)
    setBackupSwitchFailedCut(null)
    setBackupContinueFailedCut(null)
    void botBackupSwitch
      .request(
        client,
        {
          botId: activeOffer.botId,
          sessionId,
          turnItemId: cutId,
          target: activeOffer.target
        },
        { failWhenDisconnected: true }
      )
      .then((res) => {
        const { switched, continued } = botBackupSwitch.interpret(res)
        if (!switched) {
          setBackupSwitchFailedCut(cutId)
        }
        if (continued === false) {
          setBackupContinueFailedCut(cutId)
        }
      })
      .catch(() => setBackupSwitchFailedCut(cutId))
      .finally(() => setBackupSwitchingCut((current) => (current === cutId ? null : current)))
  }, [client, sessionId, activeOffer, backupSwitching])

  return activeOffer || (backupContinueFailedCut !== null && backupContinueFailedCut === turnItemId)
    ? {
        backupSwitchLabel: activeOffer
          ? (activeOffer.target.model ?? botAgentLabel(activeOffer.target.agent))
          : undefined,
        backupSwitching,
        backupSwitchFailed: backupSwitchFailedCut === turnItemId,
        backupContinuationFailed:
          backupContinueFailedCut !== null && backupContinueFailedCut === turnItemId,
        switchToBackup: activeOffer ? switchToBackup : null
      }
    : null
}
