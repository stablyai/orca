import { describe, expect, it } from 'vitest'
import {
  focusMobileMaestroFrame,
  fitMobileMaestroFrames,
  mobileMaestroInspectorInsets,
  panMobileMaestroViewport,
  pinchMobileMaestroViewport,
  projectMobileMaestroFrame,
  revealMobileMaestroFrame
} from './mobile-maestro-geometry'

describe('mobile Maestro geometry', () => {
  it('pans both canvas axes from one diagonal gesture', () => {
    expect(
      panMobileMaestroViewport({ center: { x: 100, y: 200 }, zoom: 2 }, { x: -40, y: 60 })
    ).toEqual({ center: { x: 120, y: 170 }, zoom: 2 })
  })

  it('pans toward content left of the current viewport', () => {
    expect(
      panMobileMaestroViewport({ center: { x: 100, y: 200 }, zoom: 1 }, { x: 75, y: 0 })
    ).toEqual({ center: { x: 25, y: 200 }, zoom: 1 })
  })

  it('zooms around the two-finger focal point', () => {
    const viewportSize = { width: 400, height: 800 }
    const frame = { x: 80, y: 100, width: 120, height: 160 }
    const before = projectMobileMaestroFrame(
      { center: { x: 0, y: 0 }, zoom: 1 },
      frame,
      viewportSize
    )
    const next = pinchMobileMaestroViewport(
      { center: { x: 0, y: 0 }, zoom: 1 },
      { focalPoint: { x: before.x, y: before.y }, distance: 100 },
      { focalPoint: { x: before.x, y: before.y }, distance: 200 },
      viewportSize
    )
    const after = projectMobileMaestroFrame(next, frame, viewportSize)

    expect(next.zoom).toBe(2)
    expect(after.x).toBeCloseTo(before.x)
    expect(after.y).toBeCloseTo(before.y)
  })

  it('zooms out around the two-finger focal point', () => {
    const next = pinchMobileMaestroViewport(
      { center: { x: 20, y: 40 }, zoom: 1 },
      { focalPoint: { x: 200, y: 400 }, distance: 200 },
      { focalPoint: { x: 200, y: 400 }, distance: 100 },
      { width: 400, height: 800 }
    )

    expect(next).toEqual({ center: { x: 20, y: 40 }, zoom: 0.5 })
  })

  it('pans while pinching when the two-finger midpoint moves', () => {
    const next = pinchMobileMaestroViewport(
      { center: { x: 50, y: 80 }, zoom: 1 },
      { focalPoint: { x: 200, y: 400 }, distance: 100 },
      { focalPoint: { x: 240, y: 370 }, distance: 100 },
      { width: 400, height: 800 }
    )

    expect(next).toEqual({ center: { x: 10, y: 110 }, zoom: 1 })
  })

  it('focuses a desktop-sized terminal inside the useful phone area', () => {
    const frame = { x: 400, y: 200, width: 760, height: 530 }
    const usable = { width: 390, height: 664, insetTop: 104, insetBottom: 0 }
    const viewport = focusMobileMaestroFrame(frame, usable)
    const projected = projectMobileMaestroFrame(viewport, frame, usable)

    expect(projected.x).toBeGreaterThanOrEqual(16)
    expect(projected.x + projected.width).toBeLessThanOrEqual(usable.width - 16)
    expect(projected.y).toBeGreaterThanOrEqual(usable.insetTop + 16)
    expect(projected.y + projected.height).toBeLessThanOrEqual(usable.height - 16)
    expect(viewport.zoom).toBeGreaterThan(0.4)
  })

  it('reveals a selected card outside the phone inspector', () => {
    const insets = mobileMaestroInspectorInsets(false, true)
    const next = revealMobileMaestroFrame(
      { center: { x: 0, y: 0 }, zoom: 1 },
      { x: 300, y: 220, width: 260, height: 168 },
      { width: 412, height: 915, ...insets }
    )
    const projected = projectMobileMaestroFrame(
      next,
      { x: 300, y: 220, width: 260, height: 168 },
      { width: 412, height: 915 }
    )
    expect(next.center.x).toBeGreaterThan(0)
    expect(next.center.y).toBeGreaterThan(0)
    expect(projected.y + projected.height).toBeLessThanOrEqual(915 - insets.insetBottom - 16)
  })

  it('fits populated tablet cards at a readable zoom', () => {
    const viewport = fitMobileMaestroFrames(
      [
        { x: 0, y: 0, width: 300, height: 190 },
        { x: 328, y: 0, width: 300, height: 190 },
        { x: 656, y: 0, width: 300, height: 190 }
      ],
      { width: 1280, height: 800, insetRight: 280, insetBottom: 0 }
    )
    expect(viewport.zoom).toBeGreaterThanOrEqual(0.55)
  })

  it('contains widely separated populated phone cards inside the useful area', () => {
    const frames = [
      { x: 0, y: 420, width: 320, height: 220 },
      { x: 0, y: 700, width: 320, height: 220 },
      { x: 1500, y: 420, width: 320, height: 220 }
    ]
    const usable = { width: 412, height: 915, insetRight: 0, insetBottom: 0 }
    const viewport = fitMobileMaestroFrames(frames, usable)
    const projected = frames.map((frame) => projectMobileMaestroFrame(viewport, frame, usable))

    expect(Math.min(...projected.map((frame) => frame.x))).toBeGreaterThanOrEqual(20)
    expect(Math.max(...projected.map((frame) => frame.x + frame.width))).toBeLessThanOrEqual(392)
    expect(Math.min(...projected.map((frame) => frame.y))).toBeGreaterThanOrEqual(72)
    expect(Math.max(...projected.map((frame) => frame.y + frame.height))).toBeLessThanOrEqual(895)
  })
})
