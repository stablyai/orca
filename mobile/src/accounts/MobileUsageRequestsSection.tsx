import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { View, Text, Switch } from 'react-native'
import {
  USAGE_REQUEST_PROVIDERS,
  composeUsageRequestPolicyEnabled,
  type UsageRequestProvider
} from '../../../src/shared/usage-request-policy'
import type { RpcClient } from '../transport/rpc-client'
import {
  usageRequestSettingsRead,
  usageRequestSettingsWrite
} from './usage-request-settings-operations'
import { colors } from '../theme/mobile-theme'
import { styles } from './mobile-accounts-screen-styles'

const PROVIDER_NAMES: Record<UsageRequestProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  'opencode-go': 'OpenCode Go',
  kimi: 'Kimi',
  antigravity: 'Antigravity',
  minimax: 'MiniMax',
  grok: 'Grok',
  cursor: 'Cursor',
  zcode: 'ZCode'
}

export function MobileUsageRequestsSection({
  client,
  connected,
  hostName,
  policyRevision
}: {
  client: RpcClient | null
  connected: boolean
  hostName: string
  policyRevision?: number
}) {
  const [loaded, setLoaded] = useState<{
    owner: { client: RpcClient | null; connected: boolean }
    enabled: Record<UsageRequestProvider, boolean> | null
    message: string | null
  } | null>(null)
  const [pending, setPending] = useState(false)
  const ownerEpoch = useMemo(() => ({ client, connected }), [client, connected])
  const current = useRef(ownerEpoch)
  useLayoutEffect(() => {
    current.current = ownerEpoch
  }, [ownerEpoch])
  const active = useRef(true)
  const writing = useRef(false)
  const writeSerial = useRef(0)
  const readSerial = useRef(0)

  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])

  useEffect(() => {
    if (!client || !connected) {
      return
    }
    let currentLoad = true
    const serial = writeSerial.current
    const readSerialNumber = ++readSerial.current
    const owner = ownerEpoch
    void (async () => {
      try {
        const reply = await usageRequestSettingsRead.request(client)
        const read = usageRequestSettingsRead.interpret(reply)
        if (
          !currentLoad ||
          writeSerial.current !== serial ||
          readSerialNumber !== readSerial.current
        ) {
          return
        }
        const settings = read.settings
        setLoaded({
          owner,
          enabled: composeUsageRequestPolicyEnabled(
            settings.usageRequestEnabled,
            settings.antigravityUsageEnabled
          ),
          message: null
        })
      } catch {
        if (
          currentLoad &&
          writeSerial.current === serial &&
          readSerialNumber === readSerial.current
        ) {
          setLoaded({
            owner,
            enabled: null,
            message:
              'Usage request settings are unknown. Connect to this host and update Orca there to control usage requests.'
          })
        }
      }
    })()
    return () => {
      currentLoad = false
    }
  }, [client, connected, policyRevision, ownerEpoch])

  const selected = loaded?.owner === ownerEpoch ? loaded : null
  const enabled = connected ? selected?.enabled : null
  const update = async (provider: UsageRequestProvider, value: boolean) => {
    if (!client || !enabled || !connected || writing.current) {
      return
    }
    const owner = current.current
    writing.current = true
    writeSerial.current += 1
    setPending(true)
    const precedingRead = readSerial.current
    let reconciliationRead: number | undefined
    try {
      const updates =
        provider === 'antigravity'
          ? { antigravityUsageEnabled: value }
          : { usageRequestEnabled: { [provider]: value } }
      const reply = await usageRequestSettingsWrite.request(client, updates)
      if (current.current === owner) {
        writeSerial.current += 1
      }
      const read = usageRequestSettingsWrite.interpret(reply)
      let applied = composeUsageRequestPolicyEnabled(
        read.settings.usageRequestEnabled,
        read.settings.antigravityUsageEnabled
      )
      if (applied[provider] !== value) {
        throw new Error('The host did not confirm this usage request setting.')
      }
      if (readSerial.current !== precedingRead && active.current && current.current === owner) {
        const readSerialNumber = ++readSerial.current
        reconciliationRead = readSerialNumber
        setLoaded({ owner, enabled: null, message: null })
        const latestReply = await usageRequestSettingsRead.request(client)
        if (readSerialNumber !== readSerial.current) {
          return
        }
        const latest = usageRequestSettingsRead.interpret(latestReply)
        applied = composeUsageRequestPolicyEnabled(
          latest.settings.usageRequestEnabled,
          latest.settings.antigravityUsageEnabled
        )
      }
      if (active.current && current.current === owner) {
        setLoaded({ owner, enabled: applied, message: null })
      }
    } catch (error) {
      if (reconciliationRead !== undefined && reconciliationRead !== readSerial.current) {
        return
      }
      if (active.current && current.current === owner) {
        writeSerial.current += 1
        setLoaded({
          owner,
          enabled: null,
          message: error instanceof Error ? error.message : String(error)
        })
      }
    } finally {
      writing.current = false
      if (active.current) {
        setPending(false)
      }
    }
  }

  return (
    <View style={styles.section}>
      <Text style={styles.sectionHeading}>Usage requests</Text>
      <Text style={styles.footerHintText}>
        Applies to {hostName || 'this host'}. Off stops automatic and manual usage checks. Agents,
        sign-in, and live Claude statusLine data continue. Gemini credential permission stays
        separate.
      </Text>
      {selected?.message ? <Text style={styles.errorText}>{selected.message}</Text> : null}
      {!enabled ? (
        <Text style={styles.footerHintText}>
          {connected
            ? 'Usage request settings are unknown.'
            : 'Connect to this host to view usage request settings.'}
        </Text>
      ) : (
        <View style={styles.card}>
          {USAGE_REQUEST_PROVIDERS.map((provider) => {
            const label =
              provider === 'antigravity'
                ? `${PROVIDER_NAMES[provider]}: Show and check usage`
                : `${PROVIDER_NAMES[provider]}: Check usage`
            return (
              <View key={provider} style={styles.row}>
                <Text style={[styles.footerHintText, styles.rowMain]}>{label}</Text>
                <Switch
                  accessibilityLabel={`${label} on ${hostName || 'this host'}`}
                  disabled={pending}
                  value={enabled[provider]}
                  onValueChange={(value) => {
                    void update(provider, value)
                  }}
                  trackColor={{ true: colors.textSecondary }}
                />
              </View>
            )
          })}
        </View>
      )}
    </View>
  )
}
