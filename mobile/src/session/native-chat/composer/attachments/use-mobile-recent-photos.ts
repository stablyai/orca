import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  RecentPhotoAccess,
  RecentPhotoLibrary
} from '../../../../platform/media-picking/media-picker-contract'

export const RECENT_PHOTOS_PAGE = 20

type RecentPhotosState = {
  readonly access: RecentPhotoAccess | null
  readonly ids: readonly string[]
}

const UNLOADED: RecentPhotosState = { access: null, ids: [] }

// Ask for the photos only while the sheet is open, so the permission prompt follows a tap on +.
export function useMobileRecentPhotos(
  library: RecentPhotoLibrary | null,
  open: boolean
): RecentPhotosState & { reload: () => void } {
  const [state, setState] = useState<RecentPhotosState>(UNLOADED)
  const request = useRef(0)

  const load = useCallback(() => {
    if (!library) {
      return
    }
    request.current += 1
    const current = request.current
    library.list(RECENT_PHOTOS_PAGE).then(
      (photos) => {
        if (request.current === current) {
          setState(photos)
        }
      },
      (error: unknown) => {
        console.warn('[add-context] recent photos could not be listed', error)
        if (request.current === current) {
          setState({ access: 'denied', ids: [] })
        }
      }
    )
  }, [library])

  useEffect(() => {
    if (open) {
      load()
      return
    }
    request.current += 1
  }, [load, open])

  return { ...state, reload: load }
}
