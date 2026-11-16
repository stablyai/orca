import { Component, type PropsWithChildren, type ReactNode } from 'react'

export type PageFaultBoundaryProps = PropsWithChildren<{
  onFault: (error: unknown) => void
}>

type PageFaultBoundaryState = { faulted: boolean }

// Place the boundary above the router to catch unresolved/imported routes. Recovery belongs to the shell: hash-checked disk bytes would fail again on page retry.
// Boundaries cannot catch event-handler or async rejection failures; shell load-state recovery covers those.
export class PageFaultBoundary extends Component<PageFaultBoundaryProps, PageFaultBoundaryState> {
  override state: PageFaultBoundaryState = { faulted: false }

  static getDerivedStateFromError(): PageFaultBoundaryState {
    return { faulted: true }
  }

  // Report after React unmounts the failed tree so the interrupted render need not survive it.
  override componentDidCatch(error: unknown): void {
    this.props.onFault(error)
  }

  override render(): ReactNode {
    return this.state.faulted ? null : this.props.children
  }
}
