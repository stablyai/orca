export class PlacedWorktreePathOccupiedError extends Error {
  constructor(readonly path: string) {
    super(`Path "${path}" is already in use.`)
    this.name = 'PlacedWorktreePathOccupiedError'
  }
}
