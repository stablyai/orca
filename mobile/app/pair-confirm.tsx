import { useEffect, useState } from 'react'
import { View, Text, StyleSheet, Pressable, ActivityIndicator } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { ChevronLeft } from 'lucide-react-native'
import { parsePairingCode } from '../src/transport/pairing'
import { connect } from '../src/transport/rpc-client'
import { saveHost, getNextHostName } from '../src/transport/host-store'
import type { PairingOffer } from '../src/transport/types'
import { colors, spacing, radii, typography } from '../src/theme/mobile-theme'

type Status = 'awaiting-confirm' | 'connecting' | 'error'

export default function PairConfirmScreen() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const params = useLocalSearchParams<{ code?: string }>()
  const [offer, setOffer] = useState<PairingOffer | null>(null)
  const [status, setStatus] = useState<Status>('awaiting-confirm')
  const [errorMessage, setErrorMessage] = useState('')

  useEffect(() => {
    if (!params.code) {
      setStatus('error')
      setErrorMessage('Missing pairing code')
      return
    }
    const parsed = parsePairingCode(params.code)
    if (!parsed) {
      setStatus('error')
      setErrorMessage('Not a valid pairing code')
      return
    }
    setOffer(parsed)
  }, [params.code])

  async function confirm() {
    if (!offer) return
    setStatus('connecting')
    let client: ReturnType<typeof connect> | null = null
    try {
      client = connect(offer.endpoint, offer.deviceToken, offer.publicKeyB64)
      const response = await client.sendRequest('status.get')
      client.close()
      client = null

      if (!response.ok) {
        setStatus('error')
        setErrorMessage(
          response.error.code === 'unauthorized'
            ? 'Authentication failed — token may be expired'
            : `Server error: ${response.error.message}`
        )
        return
      }

      const hostId = `host-${Date.now()}`
      const hostName = await getNextHostName()
      await saveHost({
        id: hostId,
        name: hostName,
        endpoint: offer.endpoint,
        deviceToken: offer.deviceToken,
        publicKeyB64: offer.publicKeyB64,
        lastConnected: Date.now()
      })
      router.replace(`/h/${hostId}`)
    } catch {
      setStatus('error')
      setErrorMessage('Cannot connect — check that your computer is on the same network')
    } finally {
      client?.close()
    }
  }

  function cancel() {
    router.replace('/')
  }

  const containerPadding = { paddingTop: insets.top + spacing.sm }

  return (
    <View style={[styles.container, containerPadding]}>
      <Pressable style={styles.backButton} onPress={cancel}>
        <ChevronLeft size={22} color={colors.textSecondary} />
      </Pressable>

      <View style={styles.content}>
        <Text style={styles.title}>Pair with this desktop?</Text>

        {offer && status === 'awaiting-confirm' && (
          <>
            <Text style={styles.subtitle}>
              You opened a pairing link from your desktop. Confirm to add it to your hosts.
            </Text>
            <View style={styles.detailsCard}>
              <Text style={styles.detailsLabel}>Endpoint</Text>
              <Text style={styles.detailsValue}>{offer.endpoint}</Text>
            </View>
            <Pressable style={styles.primaryButton} onPress={() => void confirm()}>
              <Text style={styles.primaryButtonText}>Pair</Text>
            </Pressable>
            <Pressable style={styles.secondaryButton} onPress={cancel}>
              <Text style={styles.secondaryButtonText}>Cancel</Text>
            </Pressable>
          </>
        )}

        {status === 'connecting' && (
          <View style={styles.centered}>
            <ActivityIndicator size="large" color={colors.textSecondary} />
            <Text style={styles.connectingText}>Connecting…</Text>
          </View>
        )}

        {status === 'error' && (
          <View style={styles.centered}>
            <Text style={styles.errorText}>{errorMessage}</Text>
            <Pressable style={styles.primaryButton} onPress={cancel}>
              <Text style={styles.primaryButtonText}>Back to home</Text>
            </Pressable>
          </View>
        )}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase,
    padding: spacing.lg
  },
  backButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm
  },
  content: {
    flex: 1,
    paddingHorizontal: spacing.sm
  },
  title: {
    fontSize: typography.titleSize,
    fontWeight: '600',
    color: colors.textPrimary,
    marginBottom: spacing.sm
  },
  subtitle: {
    fontSize: typography.bodySize,
    color: colors.textSecondary,
    lineHeight: 20,
    marginBottom: spacing.lg
  },
  detailsCard: {
    backgroundColor: colors.bgPanel,
    borderRadius: radii.input,
    padding: spacing.md,
    marginBottom: spacing.lg
  },
  detailsLabel: {
    fontSize: 12,
    color: colors.textMuted,
    marginBottom: 4
  },
  detailsValue: {
    fontSize: typography.bodySize,
    color: colors.textPrimary,
    fontFamily: 'Menlo',
    fontWeight: '500'
  },
  primaryButton: {
    backgroundColor: colors.textPrimary,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm + 2,
    borderRadius: radii.button,
    alignItems: 'center',
    marginBottom: spacing.sm
  },
  primaryButtonText: {
    color: colors.bgBase,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  secondaryButton: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm + 2,
    borderRadius: radii.button,
    alignItems: 'center'
  },
  secondaryButtonText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    fontWeight: '500'
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center'
  },
  connectingText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    marginTop: spacing.lg
  },
  errorText: {
    color: colors.statusRed,
    fontSize: typography.bodySize,
    textAlign: 'center',
    marginBottom: spacing.xl,
    lineHeight: 20
  }
})
