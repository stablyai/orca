import { TriangleAlert } from 'lucide-react-native'
import { StateView } from './ui/StateView'

/** A failed load: what failed, why, and Retry when the caller can try again. */
export function MobileLoadErrorState({
  message,
  onRetry,
  title = 'Couldn’t load this'
}: {
  message: string
  onRetry?: (() => void) | null
  title?: string
}) {
  return (
    <StateView
      icon={TriangleAlert}
      title={title}
      message={message}
      primary={onRetry ? { label: 'Retry', onPress: onRetry } : undefined}
    />
  )
}
