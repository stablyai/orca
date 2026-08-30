'use client'

import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { posterFor, videoFor } from '@/lib/demoMedia'

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReduced(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])
  return reduced
}

/** Poster by default; muted looping MP4 only while near viewport. */
export function AutoplayClip({
  src,
  poster,
  alt,
  fill = true,
  wrapperClassName
}: {
  src: string
  poster?: string
  alt: string
  fill?: boolean
  wrapperClassName?: string
}) {
  const posterSrc = poster ?? posterFor(src)
  const posterRef = useRef<HTMLImageElement | null>(null)
  const reducedMotion = usePrefersReducedMotion()
  const [inView, setInView] = useState(false)

  useEffect(() => {
    const node = posterRef.current
    if (!node) {
      return
    }
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), {
      rootMargin: '200px 0px',
      threshold: 0.01
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const active = inView && !reducedMotion
  const video = active && (
    <video
      key={videoFor(src)}
      src={videoFor(src)}
      poster={posterSrc}
      muted
      loop
      playsInline
      autoPlay
      preload="none"
      aria-hidden
      className={cn('absolute inset-0 w-full h-full', fill ? undefined : 'object-cover')}
    />
  )

  if (fill) {
    return (
      <>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={posterRef}
          src={posterSrc}
          alt={alt}
          loading="lazy"
          decoding="async"
          className="absolute inset-0 w-full h-full"
        />
        {video}
      </>
    )
  }

  return (
    <span className={cn('relative block overflow-hidden', wrapperClassName)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        ref={posterRef}
        src={posterSrc}
        alt={alt}
        loading="lazy"
        decoding="async"
        className="block w-full h-auto"
      />
      {video}
    </span>
  )
}
