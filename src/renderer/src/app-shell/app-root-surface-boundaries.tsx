import { RecoverableRenderErrorBoundary } from '../components/error-boundaries/RecoverableRenderErrorBoundary'

type BoundaryProps = {
  boundaryId: string
  resetKey?: string | number | boolean | null
  title?: string
  description?: string
  children: React.ReactNode
}

export function ModalBoundary({ children, ...props }: BoundaryProps): React.JSX.Element {
  return (
    <RecoverableRenderErrorBoundary surface="modal" compact {...props}>
      {children}
    </RecoverableRenderErrorBoundary>
  )
}

export function OverlayBoundary({ children, ...props }: BoundaryProps): React.JSX.Element {
  return (
    <RecoverableRenderErrorBoundary surface="overlay" compact {...props}>
      {children}
    </RecoverableRenderErrorBoundary>
  )
}
