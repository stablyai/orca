import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ActivityIndicator, AppState, ScrollView, Text, View } from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { useFocusEffect, useLocalSearchParams } from 'expo-router'
import { ChevronLeft } from 'lucide-react-native'
import {
  HOST_RESOURCES_METHOD,
  HOST_RESOURCES_RUNTIME_CAPABILITY,
  decodeHostResourcesSnapshot,
  type HostResourcesSnapshot
} from '../../../src/shared/host-resources'
import { NavBar } from '../components/nav-bar/NavBar'
import { NavBarButton } from '../components/nav-bar/NavBarButton'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useRouteHandoff } from '../navigation/route-handoff'
import { colors, spacing } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useHostClient } from '../transport/host-client-hooks'
import { startRuntimeStatusProbe } from '../transport/runtime-status-probe'
import {
  appendCpuSampleHistory,
  hostResourcesPollDelayMs,
  hostResourcesRefusalStopsPolling
} from './host-resources-polling'
import { styles } from './mobile-resources-screen-styles'
import { ResourcesSections } from './resource-sections'

type Capability = 'unknown' | 'present' | 'absent' | 'unreadable'
type SampleProblem = 'unreadable' | 'failed'

export function MobileResourcesScreen() {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const router = useRouteHandoff()
  const insets = useSafeAreaInsets()
  const { hostId } = useLocalSearchParams<{ hostId: string }>()
  const { client, state: connState } = useHostClient(hostId)
  const [trackedHostId, setTrackedHostId] = useState(hostId)
  const [snapshot, setSnapshot] = useState<HostResourcesSnapshot | null>(null)
  const [cpuHistory, setCpuHistory] = useState<readonly number[]>([])
  const [capability, setCapability] = useState<Capability>('unknown')
  const [methodUnsupported, setMethodUnsupported] = useState(false)
  const [sampleProblem, setSampleProblem] = useState<SampleProblem | null>(null)
  const [focused, setFocused] = useState(false)
  const [appState, setAppState] = useState(AppState.currentState)
  const [now, setNow] = useState(() => Date.now())
  const hostIdRef = useRef(hostId)
  hostIdRef.current = hostId

  if (hostId !== trackedHostId) {
    setTrackedHostId(hostId)
    setSnapshot(null)
    setCpuHistory([])
    setCapability('unknown')
    setMethodUnsupported(false)
    setSampleProblem(null)
  }

  useFocusEffect(
    useCallback(() => {
      setFocused(true)
      return () => setFocused(false)
    }, [])
  )

  useEffect(() => {
    const subscription = AppState.addEventListener('change', setAppState)
    return () => subscription.remove()
  }, [])

  useEffect(() => {
    if (client === null || connState !== 'connected') {
      return
    }
    return startRuntimeStatusProbe(client, (status) => {
      if (status === null) {
        setCapability('unreadable')
        return
      }
      setCapability(
        status.capabilities.includes(HOST_RESOURCES_RUNTIME_CAPABILITY) ? 'present' : 'absent'
      )
    })
  }, [client, connState, hostId])

  const pollDelay = hostResourcesPollDelayMs({
    focused,
    appActive: appState === 'active',
    connected: connState === 'connected',
    capabilityPresent: capability === 'present',
    unsupported: methodUnsupported
  })

  useEffect(() => {
    if (pollDelay === null || client === null || !hostId) {
      return
    }
    const requestHostId = hostId
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const schedule = () => {
      if (cancelled) {
        return
      }
      timer = setTimeout(() => {
        void sample()
      }, pollDelay)
    }

    const sample = async () => {
      if (cancelled) {
        return
      }
      try {
        const response = await client.sendRequest(HOST_RESOURCES_METHOD)
        if (cancelled || hostIdRef.current !== requestHostId) {
          return
        }
        if (!response.ok) {
          if (hostResourcesRefusalStopsPolling(response.error.code)) {
            setMethodUnsupported(true)
            return
          }
          setSampleProblem('failed')
        } else {
          const decoded = decodeHostResourcesSnapshot(response.result)
          if (decoded === null) {
            setSampleProblem('unreadable')
          } else {
            setSnapshot(decoded)
            setSampleProblem(null)
            setCpuHistory((history) => appendCpuSampleHistory(history, decoded.cpu.percent))
          }
        }
      } catch {
        if (cancelled || hostIdRef.current !== requestHostId) {
          return
        }
        setSampleProblem('failed')
      }
      schedule()
    }

    void sample()
    return () => {
      cancelled = true
      if (timer !== null) {
        clearTimeout(timer)
      }
    }
  }, [client, hostId, pollDelay])

  const hasSample = snapshot !== null
  useEffect(() => {
    if (!focused || appState !== 'active' || !hasSample) {
      return
    }
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [appState, focused, hasSample])

  let body: ReactNode
  if (connState !== 'connected') {
    body = <Text style={styles.quiet}>{t('resources.screen.notConnected', 'Not connected')}</Text>
  } else if (capability === 'absent' || methodUnsupported) {
    body = (
      <Text style={styles.quiet}>
        {t('resources.screen.updateServer', 'Update the server to see CPU, memory, and disk.')}
      </Text>
    )
  } else if (capability === 'unreadable') {
    body = <Text style={styles.problem}>{problemCopy('failed', t)}</Text>
  } else if (snapshot === null && sampleProblem === null) {
    body = (
      <View style={styles.loading}>
        <ActivityIndicator size="small" color={colors.textSecondary} />
      </View>
    )
  } else if (snapshot === null) {
    body = <Text style={styles.problem}>{problemCopy(sampleProblem, t)}</Text>
  } else {
    body = (
      <>
        {sampleProblem !== null ? (
          <Text style={styles.problem}>{problemCopy(sampleProblem, t)}</Text>
        ) : null}
        <ResourcesSections snapshot={snapshot} cpuHistory={cpuHistory} now={now} />
      </>
    )
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <NavBar
        leading={
          <NavBarButton
            icon={ChevronLeft}
            onPress={() => router.back()}
            accessibilityLabel={t('common.back', 'Back')}
          />
        }
        title={t('resources.screen.title', 'Resources')}
      />
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + spacing.xl }]}
      >
        {body}
      </ScrollView>
    </SafeAreaView>
  )
}

function problemCopy(problem: SampleProblem | null, t: Translate): string {
  if (problem === 'unreadable') {
    return t('resources.screen.sampleUnreadable', 'Could not read the latest resource sample.')
  }
  return t('resources.screen.sampleFailed', 'Could not read server resources.')
}
