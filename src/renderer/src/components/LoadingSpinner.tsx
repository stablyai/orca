import React from 'react'
import { Hourglass, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

// Reduced motion uses an hourglass rather than a stuck spinner. Hide it only when motion is allowed; hidden plus motion-reduce:block left it hidden.
export function LoadingSpinner({ className }: { className?: string }): React.JSX.Element {
  return (
    <>
      <Loader2 aria-hidden="true" className={cn('animate-spin motion-reduce:hidden', className)} />
      <Hourglass aria-hidden="true" className={cn('motion-safe:hidden', className)} />
    </>
  )
}
