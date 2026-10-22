import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'expo-router'
import { PickerModal } from '../components/PickerModal'
import { hostPickerOptions } from '../components/use-connected-host-picker'
import { selectConnectableHostProfiles } from '../transport/host-catalog-selection'
import { loadHostCatalog } from '../transport/host-store'
import type { HostProfile } from '../transport/types'

/**
 * Home's "Create Workspace On" picker, inside the overlay so the drawer that follows opens from the
 * same window. A pick starts the load at once, so the loading drawer opens as the picker leaves.
 */
export function NewWorkspaceHostPicker({
  hostIds,
  onPick
}: {
  hostIds: readonly string[]
  onPick: (hostId: string) => void
}) {
  const router = useRouter()
  const hosts = useOfferedHosts(hostIds)
  const [open, setOpen] = useState(true)
  const pickedRef = useRef(false)
  // Nothing to pick (an unreadable catalog, or every offered desktop gone) leaves the overlay rather
  // than holding an invisible screen over Home.
  const nothingToPick = hosts !== null && hosts.length === 0
  useEffect(() => {
    if (nothingToPick) {
      router.back()
    }
  }, [nothingToPick, router])
  return (
    <PickerModal
      title="Create Workspace On"
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

/** The offered desktops' profiles, in the offered order; `null` until the catalog is read, `[]` if it can't be. */
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
