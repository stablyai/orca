import { useEffect, useRef, useState } from 'react'
import {
  appUpdateChecker,
  installedAppVersion,
  openAppUpdate,
  useAppUpdateState
} from '../app-update/app-update-runtime'
import { AppUpdateSettingsRows, type AppUpdateCheckRowStatus } from './app-update-settings-rows'

const CHECK_RESULT_VISIBLE_MS = 3000
const RELATIVE_TIME_TICK_MS = 60_000

export function SettingsAppUpdateSection() {
  const state = useAppUpdateState()
  const [result, setResult] = useState<'up-to-date' | 'failed' | null>(null)
  const clearResultTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // A check newer than this reads as "just now", so the tick only has to age the label.
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), RELATIVE_TIME_TICK_MS)
    return () => clearInterval(tick)
  }, [])

  useEffect(
    () => () => {
      if (clearResultTimer.current) {
        clearTimeout(clearResultTimer.current)
      }
    },
    []
  )

  const runCheck = () => {
    setResult(null)
    void appUpdateChecker.checkNow().then((outcome) => {
      // An available update shows in the row above, so only the other outcomes need words here.
      setResult(outcome === 'available' ? null : outcome)
      if (clearResultTimer.current) {
        clearTimeout(clearResultTimer.current)
      }
      clearResultTimer.current = setTimeout(() => setResult(null), CHECK_RESULT_VISIBLE_MS)
    })
  }

  const checkStatus: AppUpdateCheckRowStatus = state.checking ? 'checking' : (result ?? 'idle')
  return (
    <AppUpdateSettingsRows
      installedVersion={installedAppVersion}
      available={state.available}
      lastCheckedAt={state.lastCheckedAt}
      now={now}
      checkStatus={checkStatus}
      onUpdate={() => state.available && openAppUpdate(state.available.url)}
      onCheck={runCheck}
    />
  )
}
