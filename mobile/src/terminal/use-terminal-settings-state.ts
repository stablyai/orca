import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  TerminalSettingsHost,
  TerminalSettingsOperations
} from './terminal-settings-operations'
import {
  AUTO_RESTORE_FIT_OPTIONS,
  TEXT_SIZE_OPTIONS,
  type RestoreValue,
  type TextSizeValue
} from './terminal-settings-options'
import { setTerminalAutoRestoreFitMsForHost } from './terminal-auto-restore-fit-state'

export function useTerminalSettingsState(
  hosts: TerminalSettingsHost[],
  operations: TerminalSettingsOperations
) {
  const [hostMs, setHostMs] = useState<Record<string, number | null | undefined>>({})
  const [pickerHostId, setPickerHostId] = useState<string | null>(null)
  const [textScale, setTextScale] = useState(1)
  const [textSizePickerOpen, setTextSizePickerOpen] = useState(false)
  const [autocompleteEnabled, setAutocompleteEnabled] = useState(false)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(false)
  useEffect(() => {
    let active = true
    mounted.current = true
    setBusy(true)
    void operations
      .loadPreferences()
      .then((preferences) => {
        if (!active) {
          return
        }
        setTextScale(preferences.textScale)
        setAutocompleteEnabled(preferences.autocompleteEnabled)
      })
      .catch(() => {
        if (active) {
          setError('Could not load terminal preferences. Go back and try again.')
        }
      })
      .finally(() => {
        if (active) {
          setBusy(false)
        }
      })
    return () => {
      active = false
      mounted.current = false
    }
  }, [operations])
  useEffect(() => {
    let active = true
    for (const host of hosts) {
      void host
        .loadFit()
        .then((ms) => {
          if (active) {
            setHostMs((current) => setTerminalAutoRestoreFitMsForHost(current, host.id, ms))
          }
        })
        .catch(() => {
          if (active) {
            setError('Could not load terminal restore preferences. Reconnect and try again.')
          }
        })
    }
    return () => {
      active = false
    }
  }, [hosts])
  const save = useCallback(async <T>(work: () => Promise<T>, complete: (result: T) => void) => {
    setBusy(true)
    setError(null)
    try {
      const result = await work()
      if (mounted.current) {
        complete(result)
      }
    } catch {
      if (mounted.current) {
        setError('Could not save terminal preferences. Try again.')
      }
    } finally {
      if (mounted.current) {
        setBusy(false)
      }
    }
  }, [])
  const selectTextSize = useCallback(
    (value: TextSizeValue) => {
      const option = TEXT_SIZE_OPTIONS.find((entry) => entry.value === value)
      if (option) {
        void save(
          () => operations.saveTextScale(option.scale),
          () => setTextScale(option.scale)
        )
      }
    },
    [operations, save]
  )
  const toggleAutocomplete = useCallback(
    (enabled: boolean) => {
      void save(
        () => operations.saveAutocomplete(enabled),
        () => setAutocompleteEnabled(enabled)
      )
    },
    [operations, save]
  )
  const selectValue = useCallback(
    async (hostId: string, value: RestoreValue) => {
      const host = hosts.find((entry) => entry.id === hostId)
      const option = AUTO_RESTORE_FIT_OPTIONS.find((entry) => entry.value === value)
      if (!host || !option) {
        return
      }
      await save(
        () => host.saveFit(option.ms),
        (ms) => setHostMs((current) => setTerminalAutoRestoreFitMsForHost(current, hostId, ms))
      )
    },
    [hosts, save]
  )
  return {
    hostMs,
    pickerHostId,
    setPickerHostId,
    textScale,
    textSizePickerOpen,
    setTextSizePickerOpen,
    autocompleteEnabled,
    selectTextSize,
    toggleAutocomplete,
    selectValue,
    busy,
    error
  }
}
