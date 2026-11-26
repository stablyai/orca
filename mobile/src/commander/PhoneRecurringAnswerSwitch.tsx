import { useEffect, useRef, useState } from 'react'
import { Text, View } from 'react-native'
import type { CommanderAccount } from '../../../src/shared/commander/memory-contract'
import { SwitchRow } from '../host-screen/workspace-options/workspace-option-rows'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { isMobileMethodUnavailableError } from '../transport/rpc/mobile-method-unavailable'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { runRpcOperation } from '../transport/rpc/rpc-operation'
import { MemoryButton, s } from './phone-memory-controls'
import { phoneRecurringAnswers, type PhoneRecurringAnswerSetting } from './phone-memory-rpc'

export function PhoneRecurringAnswerSwitch({
  account,
  client,
  onAccessError
}: {
  account: CommanderAccount
  client: RpcClient
  onAccessError: () => void
}) {
  const t = useMobileTranslation()
  const label = t('commander.ruleUse', 'Use recurring answers')
  const [setting, setSetting] = useState<PhoneRecurringAnswerSetting | null>(null)
  const [readError, setReadError] = useState('')
  const [unconfirmed, setUnconfirmed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [saving, setSaving] = useState(false)
  const pendingWrite = useRef(false)
  const epoch = useRef(0)
  const accessError = useRef(onAccessError)
  accessError.current = onAccessError

  useEffect(() => {
    const request = ++epoch.current
    pendingWrite.current = false
    setSaving(false)
    setReadError('')
    setSetting(null)
    void runRpcOperation(client, phoneRecurringAnswers, { account })
      .then((result) => {
        if (request === epoch.current) {
          setSetting(result)
        }
      })
      .catch((error) => {
        if (request !== epoch.current) {
          return
        }
        const message = error instanceof Error ? error.message : String(error)
        if (/account changed|memory access changed/i.test(message)) {
          accessError.current()
        } else {
          setReadError(message)
        }
      })
    return () => {
      epoch.current++
    }
  }, [account, client, attempt])

  async function change(enabled: boolean) {
    if (!setting || pendingWrite.current || setting.enabled === enabled) {
      return
    }
    const request = epoch.current
    pendingWrite.current = true
    setSaving(true)
    setUnconfirmed(false)
    try {
      const result = await runRpcOperation(client, phoneRecurringAnswers, {
        account,
        change: { enabled, expectedVersion: setting.version }
      })
      if (request === epoch.current) {
        setSetting(result)
      }
    } catch (error) {
      if (request !== epoch.current) {
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      if (/account changed|memory access changed/i.test(message)) {
        accessError.current()
      } else {
        setSetting(null)
        setUnconfirmed(true)
        setAttempt((previous) => previous + 1)
      }
    } finally {
      if (request === epoch.current) {
        pendingWrite.current = false
        setSaving(false)
      }
    }
  }

  if (setting) {
    return (
      <>
        <SwitchRow
          label={label}
          value={setting.enabled}
          disabled={saving}
          onChange={(enabled) => void change(enabled)}
          detail={t(
            'commander.ruleUseScope',
            'Allow each project in this account workspace to use its saved answers for exact question matches.'
          )}
        />
        {unconfirmed && (
          <Text accessibilityRole="alert" style={s.meta}>
            {t(
              'commander.ruleUseUnconfirmed',
              'Your change could not be confirmed. Check the current setting before trying again.'
            )}
          </Text>
        )}
      </>
    )
  }
  const unavailable =
    isMobileMethodUnavailableError(readError.split(':', 1)[0], readError) ||
    /unknown method/i.test(readError)
  return (
    <View style={s.item}>
      <Text style={s.title}>{label}</Text>
      {unavailable ? (
        <Text style={s.meta}>
          {t('commander.ruleUseUpdate', 'Update the paired desktop to change this setting.')}
        </Text>
      ) : readError ? (
        <>
          <Text accessibilityRole="alert" style={s.meta}>
            {readError}
          </Text>
          <MemoryButton
            label={t('common.retry', 'Retry')}
            onPress={() => setAttempt((previous) => previous + 1)}
          />
        </>
      ) : (
        <Text style={s.meta}>{t('commander.memoryLoading', 'Loading…')}</Text>
      )}
    </View>
  )
}
