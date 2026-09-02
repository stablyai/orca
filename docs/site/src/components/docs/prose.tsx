import type { ReactNode } from 'react'
import { cn } from '@/lib/class-names'
import { AutoplayClip } from '@/components/AutoplayClip'

export function Prose({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'text-[15px] leading-relaxed text-foreground/80',
        '[&_h2]:mb-3 [&_h2]:mt-10 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2]:text-foreground',
        '[&_h3]:mb-2 [&_h3]:mt-7 [&_h3]:text-base [&_h3]:font-semibold [&_h3]:text-foreground/90',
        '[&_p]:my-4',
        '[&_ul]:list-disc [&_ul]:ml-5 [&_ul]:my-4 [&_ul]:space-y-1.5',
        '[&_ol]:list-decimal [&_ol]:ml-5 [&_ol]:my-4 [&_ol]:space-y-1.5',
        '[&_li]:marker:text-muted-foreground',
        '[&_a]:text-foreground [&_a]:underline [&_a]:decoration-border [&_a]:underline-offset-4 hover:[&_a]:decoration-ring',
        '[&_code]:rounded-md [&_code]:border [&_code]:border-border [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[13px] [&_code]:text-foreground',
        '[&_pre]:my-5 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-border [&_pre]:bg-card [&_pre]:p-4 [&_pre]:font-mono [&_pre]:text-[13px]',
        '[&_pre_code]:bg-transparent [&_pre_code]:border-0 [&_pre_code]:p-0',
        '[&_strong]:font-semibold [&_strong]:text-foreground',
        '[&_hr]:my-10 [&_hr]:border-border',
        '[&_blockquote]:my-5 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground',
        '[&_table]:block [&_table]:w-full [&_table]:max-w-full [&_table]:my-6 [&_table]:overflow-x-auto [&_table]:text-sm [&_table]:border-collapse',
        '[&_th]:border-border [&_th]:border-b [&_th]:py-2 [&_th]:pr-4 [&_th]:text-left [&_th]:font-semibold [&_th]:text-foreground',
        '[&_td]:border-border [&_td]:border-b [&_td]:py-2 [&_td]:pr-4 [&_td]:align-top',
        '[&_img]:max-w-full [&_img]:h-auto',
        className
      )}
    >
      {children}
    </div>
  )
}

export function Callout({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <aside className="my-6 rounded-xl border border-border bg-card p-4 text-sm text-card-foreground">
      {title && <div className="mb-1 font-semibold text-foreground">{title}</div>}
      {children}
    </aside>
  )
}

export function ImagePlaceholder({ caption, src }: { caption: string; src?: string }) {
  if (src) {
    return (
      <figure className="my-6 overflow-hidden rounded-xl border border-border bg-card">
        {src.endsWith('.gif') ? (
          <AutoplayClip src={src} alt={caption} fill={false} />
        ) : (
          <img src={src} alt={caption} loading="lazy" decoding="async" className="block w-full" />
        )}
        <figcaption className="px-4 py-2 text-xs text-muted-foreground">{caption}</figcaption>
      </figure>
    )
  }
  return (
    <div className="my-6 rounded-xl border border-dashed border-border bg-muted px-4 py-6 text-center font-mono text-xs text-muted-foreground">
      [ image placeholder — {caption} ]
    </div>
  )
}
