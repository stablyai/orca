import React from 'react'
import { Hourglass, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

// Why: a spinner frozen by reduced motion reads as stuck, so the still state is
// a different icon that says "working" without moving.
export function LoadingSpinner({ className }: { className?: string }): React.JSX.Element {
  return (
    <>
      <Loader2 aria-hidden="true" className={cn('animate-spin motion-reduce:hidden', className)} />
      <Hourglass aria-hidden="true" className={cn('hidden motion-reduce:block', className)} />
    </>
  )
}
