import {
  createContext,
  useContext,
  useLayoutEffect,
  useState,
  type ReactNode,
  type RefObject
} from 'react'
import { createPortal, flushSync } from 'react-dom'

const DetailCardHostContext = createContext<HTMLElement | null>(null)

export function DetailCardHostProvider({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const node = document.createElement('div')
    Object.assign(node.style, {
      position: 'fixed',
      inset: '0',
      pointerEvents: 'none',
      zIndex: '1000'
    })
    document.body.append(node)
    setHost(node)
    return () => node.remove()
  }, [])
  return <DetailCardHostContext.Provider value={host}>{children}</DetailCardHostContext.Provider>
}

export function DetailCardLayer({ children }: { children: ReactNode }) {
  const host = useContext(DetailCardHostContext)
  return host ? createPortal(children, host) : null
}

export type DetailCardFocusBoundaryProps = {
  refs: RefObject<unknown[]>
  index: number
  active: boolean
}

export function DetailCardFocusBoundary({ refs, index, active }: DetailCardFocusBoundaryProps) {
  return active ? (
    <span
      ref={(node) => {
        refs.current[index] = node
      }}
      tabIndex={0}
      aria-hidden="true"
      style={{
        position: 'fixed',
        width: 1,
        height: 1,
        overflow: 'hidden',
        opacity: 0,
        pointerEvents: 'none'
      }}
    />
  ) : null
}

export function commitDetailCardExit(settle: () => void) {
  flushSync(settle)
}
