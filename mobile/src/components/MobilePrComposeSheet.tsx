import { Linking } from 'react-native'
import { BottomDrawer } from './BottomDrawer'
import { MobilePrComposeForm, type PrComposePrefill } from './pr-sidebar/MobilePrComposeForm'
import type { RpcClient } from '../transport/rpc-client'

type Props = {
  visible: boolean
  client: RpcClient | null
  worktreeId: string
  prefill: PrComposePrefill
  // Head branch — enables the base≠head guard and the "from <branch>" hint.
  head?: string | null
  onClose: () => void
  onCreated: (url: string) => void
}

// BottomDrawer wrapper around the inline compose form, for full-screen roots
// (source-control modals). The PR sidebar empty-state renders MobilePrComposeForm
// inline instead, since a BottomDrawer overlay nested in a ScrollView clips it.
export function MobilePrComposeSheet({
  visible,
  client,
  worktreeId,
  prefill,
  head,
  onClose,
  onCreated
}: Props) {
  return (
    <BottomDrawer visible={visible} onClose={onClose}>
      {/* Why: key on visible + prefill fields so reopening (or a new prefill)
          remounts the form with fresh initial values; the previous sheet reset
          its fields via an effect on the same signals. */}
      <MobilePrComposeForm
        key={`${visible}:${prefill.title}:${prefill.base}:${prefill.body}`}
        client={client}
        worktreeId={worktreeId}
        prefill={prefill}
        head={head}
        onCancel={onClose}
        onCreated={onCreated}
      />
    </BottomDrawer>
  )
}

export function openMobilePrUrl(url: string): void {
  void Linking.openURL(url)
}
