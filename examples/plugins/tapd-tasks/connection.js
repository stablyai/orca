const form = document.querySelector('form')
const token = document.querySelector('#token')
const clear = document.querySelector('#clear')
const status = document.querySelector('[role="status"]')

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  const value = token.value.trim()
  token.value = ''
  if (!value) {
    return
  }

  try {
    await orca.host.call('secrets.set', { key: 'tapd-token', value })
    status.textContent = 'Token saved. Refresh the TAPD task list.'
  } catch {
    status.textContent = 'Could not save the token in Orca’s encrypted store.'
  }
})

clear.addEventListener('click', async () => {
  token.value = ''
  try {
    await orca.host.call('secrets.delete', { key: 'tapd-token' })
    status.textContent = 'Token removed.'
  } catch {
    status.textContent = 'Could not remove the token.'
  }
})
