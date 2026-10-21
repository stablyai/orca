import { Component, type PropsWithChildren, type ReactNode } from 'react'

export type PageFaultBoundaryProps = PropsWithChildren<{
  /** Called once, on the first throw. Must not throw: nothing above this catches. */
  onFault: (error: unknown) => void
}>

type PageFaultBoundaryState = { faulted: boolean }

/**
 * The one boundary the page mounts, directly under its root and above the router.
 *
 * It renders nothing on a fault and offers nothing to press. That is the whole design: the
 * generation this page came from is on disk and was hash-checked before the view loaded it, so the
 * same bytes throw again and a retry here would only throw twice. Recovery belongs to the shell,
 * which hears the report and drops the generation, and until it acts the page showing nothing is
 * honest about what it can do.
 *
 * Above the router rather than inside it, because a route that cannot be resolved or imported
 * throws where the router renders it and a boundary below that would never see it. What it cannot
 * see either way is a throw from an event handler or a rejected promise with no render behind it;
 * React reports neither to a boundary, and the shell's own load state is what covers those.
 */
export class PageFaultBoundary extends Component<PageFaultBoundaryProps, PageFaultBoundaryState> {
  override state: PageFaultBoundaryState = { faulted: false }

  static getDerivedStateFromError(): PageFaultBoundaryState {
    return { faulted: true }
  }

  /** React calls this after the tree is already unmounted, so the report is the last thing the page
   *  does rather than something the render it interrupted has to survive. */
  override componentDidCatch(error: unknown): void {
    this.props.onFault(error)
  }

  override render(): ReactNode {
    return this.state.faulted ? null : this.props.children
  }
}
