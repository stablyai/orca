import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  type ComponentProps,
  type Ref
} from 'react'
import { Platform, ScrollView } from 'react-native'
import { MobileNativeChatDisclosureContext } from './native-chat/transcript/mobile-native-chat-disclosure-store'

const RootAddress = createContext<{ id: string; address: string; owner: string } | null>(null)

export function MobileNativeChatOwnedScrollView({
  positionKey,
  rootIdentity = positionKey,
  owner,
  initialFollow = false,
  followKey,
  ref,
  children,
  ...props
}: ComponentProps<typeof ScrollView> & {
  positionKey: string
  rootIdentity?: string
  owner?: string
  initialFollow?: boolean
  followKey?: number
  ref?: Ref<ScrollView>
}) {
  const store = useContext(MobileNativeChatDisclosureContext)
  const parent = useContext(RootAddress)
  const id = parent ? `${parent.id}/${rootIdentity}` : rootIdentity
  const address = parent ? `${parent.address}/${positionKey}` : positionKey
  const rootOwner = owner ?? parent?.owner ?? id
  const value = useMemo(() => ({ id, address, owner: rootOwner }), [id, address, rootOwner])
  const roots = store?.roots
  const scroll = useRef<ScrollView>(null)
  const release = useRef<(() => void) | undefined>(undefined)
  const attach = useCallback(
    (node: ScrollView | null) => {
      scroll.current = node
      if (typeof ref === 'function') {
        return ref(node)
      }
      if (ref) {
        ref.current = node
      }
    },
    [ref]
  )
  useLayoutEffect(
    () => () => {
      release.current?.()
      release.current = undefined
    },
    [roots, id]
  )
  useLayoutEffect(() => {
    if (Platform.OS !== 'web' || !roots) {
      return
    }
    const node: unknown = scroll.current?.getScrollableNode()
    if (
      typeof HTMLElement !== 'undefined' &&
      node instanceof HTMLElement &&
      node.firstElementChild !== null
    ) {
      release.current = roots.register(
        id,
        node,
        node.firstElementChild,
        rootOwner,
        address,
        initialFollow
      )
      roots.layout(id, address, followKey)
    }
  })
  return (
    <ScrollView {...props} ref={attach}>
      <RootAddress.Provider value={value}>{children}</RootAddress.Provider>
    </ScrollView>
  )
}
