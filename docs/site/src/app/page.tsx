import { redirect } from 'next/navigation'

/** Docs package root — keep public URLs at /docs. */
export default function Home() {
  redirect('/docs')
}
