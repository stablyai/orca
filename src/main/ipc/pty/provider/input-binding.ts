import {
  ptyInputTransactionKey,
  type PtyInputBinding
} from '../../../runtime/pty-input-transactions'
import { ptyIncarnationById, ptyOwnership } from './ownership-state'
import { tryGetProviderForPty } from './registry'

export function bindProviderPtyInput(id: string): PtyInputBinding {
  let incarnation = ptyIncarnationById.get(id)
  const owner = ptyOwnership.get(id)
  return {
    key: ptyInputTransactionKey(id),
    isCurrent: () => {
      const currentIncarnation = ptyIncarnationById.get(id)
      incarnation ??= currentIncarnation
      const provider = tryGetProviderForPty(id)
      return (
        ptyOwnership.get(id) === owner &&
        currentIncarnation === incarnation &&
        !!provider &&
        provider.hasPty?.(id) !== false
      )
    }
  }
}
