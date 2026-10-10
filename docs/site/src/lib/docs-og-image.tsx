import { ImageResponse } from 'next/og'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { findParent } from 'fumadocs-core/page-tree'
import { source } from '@/lib/source'

export const ogImageSize = { width: 1200, height: 630 }
export const ogImageContentType = 'image/png'

const fontsDir = join(process.cwd(), 'src/assets/fonts')
// Satori cannot read the site stylesheet, so mirror Orca's canonical dark tokens here.
const ogColors = {
  background: '#0a0a0a',
  foreground: '#fafafa',
  card: '#171717',
  secondary: '#262626',
  mutedForeground: '#a1a1a1',
  border: 'rgb(255 255 255 / 0.07)'
} as const

function getSectionLabel(url: string): string {
  const parent = findParent(source.pageTree, url)
  if (parent?.type === 'folder' && parent.name) {
    return String(parent.name)
  }
  return 'Documentation'
}

function getFooterTag(title: string, section: string): string {
  return `${title} - ${section} - Orca`
}

function getTitleFontSize(title: string): number {
  if (title.length > 40) {
    return 48
  }
  if (title.length > 28) {
    return 60
  }
  return 72
}

export async function createDocsOgImage({ title, url }: { title: string; url: string }) {
  const section = getSectionLabel(url)
  const footerTag = getFooterTag(title, section)
  const titleFontSize = getTitleFontSize(title)

  const [logoData, geistRegular, geistBold] = await Promise.all([
    readFile(join(process.cwd(), 'public/docs/logo.svg'), 'base64'),
    // next/og's Satori renderer accepts static TrueType fonts, while the
    // browser stylesheet uses the smaller variable WOFF2 variant.
    readFile(join(fontsDir, 'Geist-Regular.ttf')),
    readFile(join(fontsDir, 'Geist-Bold.ttf'))
  ])

  const logoSrc = `data:image/svg+xml;base64,${logoData}`
  const regularFont = geistRegular.buffer.slice(
    geistRegular.byteOffset,
    geistRegular.byteOffset + geistRegular.byteLength
  )
  const boldFont = geistBold.buffer.slice(
    geistBold.byteOffset,
    geistBold.byteOffset + geistBold.byteLength
  )

  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: ogColors.background
      }}
    >
      <div
        style={{
          width: 1080,
          height: 550,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          borderRadius: 14,
          background: ogColors.card,
          border: `1px solid ${ogColors.border}`,
          padding: 56
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 48,
            height: 48,
            borderRadius: 8,
            border: `1px solid ${ogColors.border}`,
            background: ogColors.secondary
          }}
        >
          <img src={logoSrc} width={32} height={20} alt="" />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div
            style={{
              fontSize: 20,
              fontWeight: 400,
              color: ogColors.mutedForeground,
              fontFamily: 'Geist'
            }}
          >
            {section}
          </div>
          <div
            style={{
              fontSize: titleFontSize,
              fontWeight: 700,
              color: ogColors.foreground,
              fontFamily: 'Geist',
              lineHeight: 1.08,
              letterSpacing: '-0.02em',
              maxWidth: 900
            }}
          >
            {title}
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              padding: '10px 16px',
              borderRadius: 8,
              background: ogColors.secondary,
              border: `1px solid ${ogColors.border}`,
              alignSelf: 'flex-start'
            }}
          >
            <div
              style={{
                fontSize: 16,
                fontWeight: 400,
                color: ogColors.foreground,
                fontFamily: 'Geist'
              }}
            >
              {footerTag}
            </div>
          </div>
        </div>
      </div>
    </div>,
    {
      ...ogImageSize,
      fonts: [
        {
          name: 'Geist',
          data: regularFont,
          style: 'normal',
          weight: 400
        },
        {
          name: 'Geist',
          data: boldFont,
          style: 'normal',
          weight: 700
        }
      ]
    }
  )
}
