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

  useEffect(() => {
    if (!live || !client || !sessionId || !turnItemId || backupState !== 'ask-backup') {
      return
    }
    let current = true
    void (async () => {
      try {
        const listed = botsListRead.interpret(await botsListRead.request(client, {}))
        if (!current || listed.kind !== 'bots') {
          return
        }
        const matched = listed.value.bots.find(
          (bot) =>
            bot.chatSessionId === sessionId ||
            (sourceIdentity !== undefined &&
              sourceIdentity.includes(folderWorkspaceKey(bot.folderWorkspaceId)))
        )
        if (!matched) {
          return
        }
        const status = botBackupStatusRead.interpret(
          await botBackupStatusRead.request(
            client,
            { botId: matched.id },
            { failWhenDisconnected: true }
          )
        )
        const ready =
          status.entries.find((entry) => entry.state === 'ready')?.entry ??
          matched.backupModels?.order[0]
        if (current && ready) {
          setBackupOffer({ turnItemId, botId: matched.id, target: ready })
        }
      } catch {
        // Ignore when the host does not offer backup status.
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
        if (!botBackupSwitch.interpret(res).switched) {
          setBackupSwitchFailedCut(cutId)
        }
      })
      .catch(() => setBackupSwitchFailedCut(cutId))
      .finally(() => setBackupSwitchingCut((current) => (current === cutId ? null : current)))
  }, [client, sessionId, activeOffer, backupSwitching])

  return activeOffer
    ? {
        backupSwitchLabel: activeOffer.target.model ?? botAgentLabel(activeOffer.target.agent),
        backupSwitching,
        backupSwitchFailed: backupSwitchFailedCut === turnItemId,
        switchToBackup
      }
    : null
}
