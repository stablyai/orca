import type { MobileMarkdownImageAssetProps } from './MobileMarkdownImageAsset'

export function MobileMarkdownImageAsset({
  uri,
  label,
  width,
  onError
}: MobileMarkdownImageAssetProps) {
  return (
    <img
      src={uri}
      alt={label}
      width={width}
      style={{ display: 'block', maxWidth: '100%', height: 'auto' }}
      onError={onError}
    />
  )
}
