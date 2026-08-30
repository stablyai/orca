import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { Space_Grotesk, DM_Sans, JetBrains_Mono } from 'next/font/google'
import { RootProvider } from 'fumadocs-ui/provider/next'
import './globals.css'

const spaceGrotesk = Space_Grotesk({
  variable: '--font-space-grotesk',
  subsets: ['latin']
})

const dmSans = DM_Sans({
  variable: '--font-dm-sans',
  subsets: ['latin']
})

const jetbrainsMono = JetBrains_Mono({
  variable: '--font-jetbrains-mono',
  subsets: ['latin']
})

const siteUrl = 'https://www.onorca.dev'

export const metadata: Metadata = {
  title: 'Orca Docs',
  description: 'Product documentation for Orca — the worktree IDE for AI coding agents.',
  metadataBase: new URL(siteUrl),
  applicationName: 'Orca Docs',
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: `${siteUrl}/docs`,
    siteName: 'Orca',
    title: 'Orca Docs',
    description: 'Product documentation for Orca — the worktree IDE for AI coding agents.'
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Orca Docs',
    description: 'Product documentation for Orca — the worktree IDE for AI coding agents.'
  },
  robots: {
    index: true,
    follow: true
  },
  alternates: {
    canonical: `${siteUrl}/docs`
  }
}

export default function RootLayout({
  children
}: Readonly<{
  children: ReactNode
}>) {
  return (
    <html
      lang="en"
      className={`dark bg-background text-foreground ${spaceGrotesk.variable} ${dmSans.variable} ${jetbrainsMono.variable}`}
      suppressHydrationWarning
    >
      <body className="font-sans antialiased" suppressHydrationWarning>
        <RootProvider theme={{ enabled: false, forcedTheme: 'dark' }} search={{ enabled: false }}>
          {children}
        </RootProvider>
      </body>
    </html>
  )
}
