import { ImageResponse } from 'next/og'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { findParent } from 'fumadocs-core/page-tree'
import { source } from '@/lib/source'

export const ogImageSize = { width: 1200, height: 630 }
export const ogImageContentType = 'image/png'

const fontsDir = join(process.cwd(), 'src/assets/fonts')

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
    return 56
  }
  return 72
}

export async function createDocsOgImage({ title, url }: { title: string; url: string }) {
  const section = getSectionLabel(url)
  const footerTag = getFooterTag(title, section)
  const titleFontSize = getTitleFontSize(title)

  const [logoData, dmSansRegular, dmSansBold] = await Promise.all([
    readFile(join(process.cwd(), 'public/logo.svg'), 'base64'),
    readFile(join(fontsDir, 'dm-sans-400.woff')),
    readFile(join(fontsDir, 'dm-sans-700.woff'))
  ])

  const logoSrc = `data:image/svg+xml;base64,${logoData}`
  const regularFont = dmSansRegular.buffer.slice(
    dmSansRegular.byteOffset,
    dmSansRegular.byteOffset + dmSansRegular.byteLength
  )
  const boldFont = dmSansBold.buffer.slice(
    dmSansBold.byteOffset,
    dmSansBold.byteOffset + dmSansBold.byteLength
  )

  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#000000'
      }}
    >
      <div
        style={{
          width: 1080,
          height: 550,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          borderRadius: 24,
          background:
            'linear-gradient(145deg, #343434 0%, #1f1f1f 14%, #0a0a0a 38%, #030303 52%, #0f0f0f 72%, #242424 88%, #2f2f2f 100%)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06), inset 0 -24px 48px rgba(0,0,0,0.45)',
          border: '1px solid rgba(255,255,255,0.08)',
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
            borderRadius: 10,
            border: '1px solid rgba(255,255,255,0.12)',
            background: '#000000'
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={logoSrc} width={32} height={20} alt="" />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div
            style={{
              fontSize: 20,
              fontWeight: 400,
              color: 'rgba(255,255,255,0.55)',
              fontFamily: 'DM Sans'
            }}
          >
            {section}
          </div>
          <div
            style={{
              fontSize: titleFontSize,
              fontWeight: 700,
              color: '#ffffff',
              fontFamily: 'DM Sans',
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
              background: '#000000',
              border: '1px solid rgba(255,255,255,0.1)',
              alignSelf: 'flex-start'
            }}
          >
            <div
              style={{
                fontSize: 16,
                fontWeight: 400,
                color: '#ffffff',
                fontFamily: 'DM Sans'
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
          name: 'DM Sans',
          data: regularFont,
          style: 'normal',
          weight: 400
        },
        {
          name: 'DM Sans',
          data: boldFont,
          style: 'normal',
          weight: 700
        }
      ]
    }
  )
}
