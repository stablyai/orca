import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'expo-router'
import { PickerModal } from '../components/PickerModal'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { hostPickerOptions } from '../components/use-connected-host-picker'
import { selectConnectableHostProfiles } from '../transport/host-catalog-selection'
import { loadHostCatalog } from '../transport/host-store'
import type { HostProfile } from '../transport/types'

// Keep picker and loading drawer in the overlay’s window so the load can start as selection leaves.
export function NewWorkspaceHostPicker({
  hostIds,
  onPick
}: {
  hostIds: readonly string[]
  onPick: (hostId: string) => void
}) {
  const t = useMobileTranslation()
  const router = useRouter()
  const hosts = useOfferedHosts(hostIds)
  const [open, setOpen] = useState(true)
  const pickedRef = useRef(false)
  // Exit if no usable desktop remains; otherwise an invisible overlay would block Home.
  const nothingToPick = hosts !== null && hosts.length === 0
  useEffect(() => {
    if (nothingToPick) {
      router.back()
    }
  }, [nothingToPick, router])
  return (
    <PickerModal
      title={t('newWorkspace.hostPicker.title', 'Create Workspace On')}
      visible={hosts !== null && !nothingToPick && open}
      options={hostPickerOptions(hosts ?? [])}
      selected=""
      onSelect={(hostId) => {
        pickedRef.current = true
        onPick(hostId)
      }}
      onClose={() => setOpen(false)}
      onAfterClose={() => {
        if (!pickedRef.current) {
          router.back()
        }
      }}
    />
  )
}

// Preserve offered order; null is loading and empty is unreadable/unavailable.
function useOfferedHosts(hostIds: readonly string[]): HostProfile[] | null {
  const [hosts, setHosts] = useState<HostProfile[] | null>(null)
  const key = hostIds.join(',')
  useEffect(() => {
    let live = true
    void loadHostCatalog()
      .then((catalog) => {
        const profiles = new Map(
          selectConnectableHostProfiles(catalog).map((host) => [host.id, host] as const)
        )
        return key.split(',').flatMap((hostId) => profiles.get(hostId) ?? [])
      })
      .catch(() => [])
      .then((offered) => {
        if (live) {
          setHosts(offered)
        }
      })
    return () => {
      live = false
    }
  }, [key])
  return hosts
}
