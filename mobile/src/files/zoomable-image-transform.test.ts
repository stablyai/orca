import { describe, expect, it } from 'vitest'
import {
  MAX_ZOOMABLE_IMAGE_SCALE,
  clampZoomableImagePan,
  clampZoomableImageScale,
  zoomableImageFocalTransform
} from './zoomable-image-transform'

const IMAGE = { imageWidth: 390, imageHeight: 700 }

describe('clampZoomableImageScale', () => {
  it('pins the scale between 1 and the maximum', () => {
    expect(clampZoomableImageScale(0.5)).toBe(1)
    expect(clampZoomableImageScale(1)).toBe(1)
    expect(clampZoomableImageScale(2.4)).toBe(2.4)
    expect(clampZoomableImageScale(9)).toBe(MAX_ZOOMABLE_IMAGE_SCALE)
  })
})

describe('clampZoomableImagePan', () => {
  it('centers the image at scale 1 whatever the translate asked for', () => {
    expect(clampZoomableImagePan(-80, 120, 1, IMAGE.imageWidth, IMAGE.imageHeight)).toEqual({
      translateX: 0,
      translateY: 0
    })
  })

  it('pans no further than the grown image edge', () => {
    const at2x = clampZoomableImagePan(-500, 300, 2, IMAGE.imageWidth, IMAGE.imageHeight)
    expect(at2x).toEqual({ translateX: -195, translateY: 300 })
    const within = clampZoomableImagePan(-100, 300, 2, IMAGE.imageWidth, IMAGE.imageHeight)
    expect(within).toEqual({ translateX: -100, translateY: 300 })
  })
})

describe('zoomableImageFocalTransform', () => {
  const center = { centerX: 195, centerY: 350 }

  it('answers the same transform when the ratio is 1', () => {
    expect(
      zoomableImageFocalTransform({
        ...center,
        ...IMAGE,
        scale: 2,
        scaleRatio: 1,
        translateX: -40,
        translateY: 60,
        focalX: 195,
        focalY: 350
      })
    ).toEqual({ scale: 2, translateX: -40, translateY: 60 })
  })

  it('zooms about the container center without translating', () => {
    expect(
      zoomableImageFocalTransform({
        ...center,
        ...IMAGE,
        scale: 1,
        scaleRatio: 2,
        translateX: 0,
        translateY: 0,
        focalX: 195,
        focalY: 350
      })
    ).toEqual({ scale: 2, translateX: 0, translateY: 0 })
  })

  it('holds the point under the focal still: a right-edge pinch drags the image left', () => {
    const next = zoomableImageFocalTransform({
      ...center,
      ...IMAGE,
      scale: 1,
      scaleRatio: 2,
      translateX: 0,
      translateY: 0,
      focalX: 390,
      focalY: 350
    })
    // The right edge stays on screen: translate + scale * (390 - 195) = 390 - 195.
    expect(next).toEqual({ scale: 2, translateX: -195, translateY: 0 })
  })

  it('carries an existing translate along the growth', () => {
    const next = zoomableImageFocalTransform({
      ...center,
      ...IMAGE,
      scale: 2,
      scaleRatio: 1.5,
      translateX: -100,
      translateY: 0,
      focalX: 195,
      focalY: 350
    })
    expect(next).toEqual({ scale: 3, translateX: -150, translateY: 0 })
  })

  it('clamps the scale at the maximum and the pan at the grown edge', () => {
    const next = zoomableImageFocalTransform({
      ...center,
      ...IMAGE,
      scale: 1,
      scaleRatio: 6,
      translateX: 0,
      translateY: 0,
      focalX: 390,
      focalY: 700
    })
    expect(next).toEqual({
      scale: MAX_ZOOMABLE_IMAGE_SCALE,
      translateX: -585,
      translateY: -1050
    })
  })
})
