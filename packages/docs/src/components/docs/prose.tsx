import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { AutoplayClip } from '@/components/AutoplayClip'

export function Prose({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'text-[15px] leading-relaxed text-white/70',
        '[&_h2]:text-white [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:mt-10 [&_h2]:mb-3 [&_h2]:tracking-tight',
        '[&_h3]:text-white/90 [&_h3]:text-base [&_h3]:font-semibold [&_h3]:mt-7 [&_h3]:mb-2',
        '[&_p]:my-4',
        '[&_ul]:list-disc [&_ul]:ml-5 [&_ul]:my-4 [&_ul]:space-y-1.5',
        '[&_ol]:list-decimal [&_ol]:ml-5 [&_ol]:my-4 [&_ol]:space-y-1.5',
        '[&_li]:marker:text-white/45',
        '[&_a]:text-white [&_a]:underline [&_a]:decoration-white/30 [&_a]:underline-offset-4 hover:[&_a]:decoration-white/70',
        '[&_code]:font-mono [&_code]:text-[13px] [&_code]:bg-white/[0.07] [&_code]:border [&_code]:border-white/[0.08] [&_code]:rounded [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-white/85',
        '[&_pre]:font-mono [&_pre]:text-[13px] [&_pre]:bg-white/[0.04] [&_pre]:border [&_pre]:border-white/[0.08] [&_pre]:rounded-lg [&_pre]:p-4 [&_pre]:my-5 [&_pre]:overflow-x-auto',
        '[&_pre_code]:bg-transparent [&_pre_code]:border-0 [&_pre_code]:p-0',
        '[&_strong]:text-white/90 [&_strong]:font-semibold',
        '[&_hr]:border-white/10 [&_hr]:my-10',
        '[&_blockquote]:border-l-2 [&_blockquote]:border-white/20 [&_blockquote]:pl-4 [&_blockquote]:text-white/60 [&_blockquote]:my-5',
        '[&_table]:block [&_table]:w-full [&_table]:max-w-full [&_table]:my-6 [&_table]:overflow-x-auto [&_table]:text-sm [&_table]:border-collapse',
        '[&_th]:text-left [&_th]:text-white [&_th]:font-semibold [&_th]:border-b [&_th]:border-white/15 [&_th]:py-2 [&_th]:pr-4',
        '[&_td]:border-b [&_td]:border-white/[0.06] [&_td]:py-2 [&_td]:pr-4 [&_td]:align-top',
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
    <aside className="my-6 rounded-lg border border-white/[0.1] bg-white/[0.03] p-4 text-sm text-white/75">
      {title && <div className="font-semibold text-white mb-1">{title}</div>}
      {children}
    </aside>
  )
}

export function ImagePlaceholder({ caption, src }: { caption: string; src?: string }) {
  if (src) {
    return (
      <figure className="my-6 overflow-hidden rounded-lg border border-white/[0.08] bg-white/[0.02]">
        {src.endsWith('.gif') ? (
          <AutoplayClip src={src} alt={caption} fill={false} />
        ) : (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img src={src} alt={caption} loading="lazy" decoding="async" className="block w-full" />
        )}
        <figcaption className="px-4 py-2 text-xs text-white/50">{caption}</figcaption>
      </figure>
    )
  }
  return (
    <div className="my-6 rounded-lg border border-dashed border-white/[0.12] bg-white/[0.02] px-4 py-6 text-center text-xs font-mono text-white/55">
      [ image placeholder — {caption} ]
    </div>
  )
}
