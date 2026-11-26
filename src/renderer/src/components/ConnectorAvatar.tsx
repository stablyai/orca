import { useState } from 'react'
import { cn } from '@/lib/class-names'
import { connectorAvatarSrc } from '../../../shared/connector-avatar-scheme'
import { connectorAskerInitials } from '../../../shared/connectors/connector-message-asker-view'

/** A connector person's picture, cached by the desktop; a client that can't serve it (or a failed
 *  fetch) shows `fallback`, or initials. `className` sizes and places it. */
export function ConnectorAvatar({
  avatarUrl,
  name,
  className,
  fallback
}: {
  avatarUrl: string | null | undefined
  name: string
  className?: string
  fallback?: React.ReactNode
}): React.JSX.Element {
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const src = avatarUrl ? connectorAvatarSrc(avatarUrl) : null
  if (src && failedSrc !== src) {
    return (
      <img
        src={src}
        alt=""
        aria-hidden
        className={cn('shrink-0 rounded-full object-cover', className)}
        onError={() => setFailedSrc(src)}
      />
    )
  }
  if (fallback) {
    return <>{fallback}</>
  }
  return (
    <span
      aria-hidden
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full bg-muted text-3xs font-medium text-muted-foreground',
        className
      )}
    >
      {connectorAskerInitials(name)}
    </span>
  )
}
