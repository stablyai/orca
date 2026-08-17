import { forwardRef, type ComponentProps } from 'react'
import { cn } from '@/lib/utils'

export const ComposerPromptTextarea = forwardRef<HTMLTextAreaElement, ComponentProps<'textarea'>>(
  function ComposerPromptTextarea({ className, rows = 2, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        rows={rows}
        className={cn(
          'scrollbar-sleek block min-h-12 w-full min-w-0 resize-none overflow-y-auto bg-transparent px-2 py-1 text-sm outline-none pointer-coarse:min-h-14',
          '[field-sizing:content] max-h-[25dvh]',
          'placeholder:text-muted-foreground/60 disabled:cursor-not-allowed disabled:opacity-50',
          className
        )}
        {...props}
      />
    )
  }
)
