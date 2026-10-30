import { Component } from 'react'
import { Platform } from 'react-native'
import type { MobileNativeChatRowKeys } from './native-chat/transcript/mobile-native-chat-row-keys'
import type { MobileNativeChatScrollRoots } from './mobile-native-chat-scroll-roots'

type Props = {
  children?: React.ReactNode
  roots?: MobileNativeChatScrollRoots
  runPlacements?: ReadonlyMap<string, string>
  rowKeys: Pick<MobileNativeChatRowKeys, 'scope'>
  /** How rows draw (tools shown, text size); a change regroups every open box. */
  layoutKey?: string
}

// Use getSnapshotBeforeUpdate to capture nested scroll boxes before DOM changes, then restore deepest first.
export class MobileNativeChatScrollRootsBoundary extends Component<Props> {
  getSnapshotBeforeUpdate(previous: Props): null {
    if (Platform.OS === 'web' && previous.rowKeys.scope === this.props.rowKeys.scope) {
      const moved = new Set(
        Array.from(previous.runPlacements ?? []).flatMap(([owner, row]) =>
          this.props.runPlacements?.get(owner) !== row ? [owner] : []
        )
      )
      this.props.roots?.capture(moved, previous.layoutKey !== this.props.layoutKey)
    }
    return null
  }

  componentDidMount(): void {
    this.props.roots?.restoreAll()
  }

  componentDidUpdate(previous: Props): void {
    try {
      this.props.roots?.restoreAll(previous.layoutKey !== this.props.layoutKey, false)
    } finally {
      this.props.roots?.releaseHold()
    }
  }

  render(): React.ReactNode {
    return this.props.children ?? null
  }
}
