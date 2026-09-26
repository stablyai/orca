package expo.modules.orcamobilewebshell

import android.app.Activity
import android.os.*
import com.facebook.react.bridge.ReactContext
import com.facebook.react.jstasks.HeadlessJsTaskContext
import java.util.concurrent.CompletableFuture

private fun message(generation: String, id: Int, endpoint: Messenger? = null, foreground: Boolean = false) =
  Message.obtain().apply {
    arg1 = id; replyTo = endpoint
    data.putString("generation", generation)
    data.putString("result", "{}")
    data.putBoolean("foreground", foreground)
  }

private class Guest(ready: Boolean = true, val owner: BrowserGuestOwner = BrowserGuestOwner()) {
  val activity = Activity()
  val open = owner.open(activity, "{}")
  val generation = requireNotNull(activity.launch?.extras?.get("generation") as? String)
  val receiver = requireNotNull(activity.launch?.extras?.get("owner") as? Messenger)
  val endpoint = Messenger(Handler(Looper.getMainLooper()) { true })
  init { if (ready) attach() }
  fun attach() {
    receiver.send(message(generation, -1, endpoint))
    receiver.send(message(generation, 0))
  }
  fun foreground(value: Boolean) { receiver.send(message(generation, -2, foreground = value)) }
  fun reopen() = owner.open(activity, "{}")
}

private fun failure(future: CompletableFuture<String>, expected: String): Throwable {
  check(future.isCompletedExceptionally) { "Expected immediate failure: $expected" }
  val cause = runCatching { future.join() }.exceptionOrNull()?.cause
  check(cause?.message == expected) { "Expected $expected, got $cause" }
  return requireNotNull(cause)
}

private fun scenario(name: String, block: () -> Unit) {
  Scheduler.reset()
  HeadlessJsTaskContext.instance.active.clear()
  HeadlessJsTaskContext.instance.fail = false
  block()
  println("PASS: $name")
}

fun main() {
  for (transport in listOf(TransactionTooLargeException(), DeadObjectException())) {
    scenario("${transport.javaClass.simpleName}: command failure retains lease without replay") {
      val guest = Guest()
      guest.endpoint.binder.failure = transport
      val command = guest.owner.command(guest.generation, "side-effect")
      check(failure(command, "guest_transport_unavailable").cause === transport)
      check(guest.endpoint.binder.alive)
      failure(guest.reopen(), "guest_process_occupied")
      Scheduler.advance(12000)
      check(guest.endpoint.sends == 1 && guest.activity.launches == 1)
      guest.endpoint.binder.die()
      check(!guest.reopen().isDone && guest.activity.launches == 2)
    }
    scenario("${transport.javaClass.simpleName}: close failure never confirms close") {
      val guest = Guest()
      guest.endpoint.binder.failure = transport
      val close = guest.owner.close(guest.generation)
      failure(close, "guest_transport_unavailable")
      check(guest.endpoint.binder.alive)
      failure(guest.reopen(), "guest_process_occupied")
      failure(guest.owner.close(guest.generation), "stale_guest_generation")
      Scheduler.advance(15000)
      check(guest.endpoint.sends == 1)
      guest.endpoint.binder.die()
      failure(close, "guest_transport_unavailable")
      check(!guest.reopen().isDone)
    }
  }
  scenario("actual death fails pending command and frees profile") {
    val guest = Guest()
    val command = guest.owner.command(guest.generation, "{}")
    check(!command.isDone)
    guest.endpoint.binder.die()
    failure(command, "guest_process_exited")
    check(HeadlessJsTaskContext.instance.active.isEmpty())
    val reopened = guest.reopen()
    guest.receiver.send(message(guest.generation, 0))
    check(!reopened.isDone)
  }
  scenario("close requires death and rejects duplicate") {
    val guest = Guest()
    val wait = guest.owner.whenEnded(guest.generation)
    val close = guest.owner.close(guest.generation)
    check(wait.join() == "{}" && !close.isDone)
    failure(guest.owner.close(guest.generation), "stale_guest_generation")
    guest.endpoint.binder.die()
    check(close.join() == "{}" && guest.activity.unbinds == 1)
  }
  scenario("unconfirmed close stays occupied after timeout") {
    val guest = Guest()
    val close = guest.owner.close(guest.generation)
    Scheduler.advance(5000)
    failure(close, "guest_close_unconfirmed")
    failure(guest.reopen(), "guest_process_occupied")
  }
  scenario("ambiguous bind failure preserves cause and occupied profile") {
    val owner = BrowserGuestOwner()
    val activity = Activity().apply { fail = true }
    failure(owner.open(activity, "{}"), "injected_launch_denied")
    activity.fail = false
    failure(owner.open(activity, "{}"), "guest_process_occupied")
  }
  scenario("refused bind frees unlaunched slot") {
    val owner = BrowserGuestOwner()
    val activity = Activity().apply { accepted = false }
    failure(owner.open(activity, "{}"), "guest_bind_failed")
    check(activity.unbinds == 1)
    activity.accepted = true
    check(!owner.open(activity, "{}").isDone)
  }
  scenario("close immediately settles presentation and ignores late foreground") {
    val guest = Guest()
    val resume = guest.owner.resume(guest.activity, guest.generation)
    check(!resume.isDone && guest.activity.activityLaunches == 1)
    guest.owner.close(guest.generation)
    failure(resume, "guest_closed")
    guest.foreground(true)
    Scheduler.advance(5000)
    failure(resume, "guest_closed")
  }
  scenario("task token fences replacement; stopping React does not release native owner") {
    val guest = Guest()
    val first = BrowserGuestReactTask(ReactContext(), guest.generation)
    first.start()
    val oldToken = HeadlessJsTaskContext.instance.last!!.data.values.getValue("taskToken")
    val wait = first.waitForStop(oldToken)
    first.stop()
    check(wait.isDone)
    failure(guest.reopen(), "guest_process_occupied")
    val replacement = BrowserGuestReactTask(ReactContext(), guest.generation)
    replacement.start()
    check(replacement.waitForStop(oldToken).isDone)
    first.stop()
    check(HeadlessJsTaskContext.instance.active.size == 1)
    replacement.stop()
  }
  scenario("creation and background command do not present; disconnection is not death") {
    val guest = Guest()
    check(guest.activity.activityLaunches == 0)
    val command = guest.owner.command(guest.generation, "{}")
    check(!command.isDone && guest.endpoint.sends == 1)
    guest.activity.connection!!.onServiceDisconnected(android.content.ComponentName())
    check(guest.activity.unbinds == 1)
    failure(guest.reopen(), "guest_process_occupied")
    guest.endpoint.binder.die()
    failure(command, "guest_process_exited")
    check(guest.activity.unbinds == 1)
  }
  scenario("module replacement drops old React task without retiring native page") {
    val guest = Guest(owner = BrowserGuestOwner.process)
    val old = BrowserGuestReactSession()
    old.start(ReactContext(), guest.generation)
    val replacement = BrowserGuestReactSession()
    replacement.start(ReactContext(), guest.generation)
    check(HeadlessJsTaskContext.instance.active.size == 2)
    old.destroy()
    old.start(ReactContext(), guest.generation)
    check(HeadlessJsTaskContext.instance.active.size == 1)
    failure(guest.reopen(), "guest_process_occupied")
    guest.endpoint.binder.die()
    check(HeadlessJsTaskContext.instance.active.isEmpty())
    replacement.destroy()
  }
  for (operation in listOf("command", "presentation")) {
    scenario("stale $operation preserves current task and page across confirmed generation change") {
      val first = Guest(owner = BrowserGuestOwner.process)
      val session = BrowserGuestReactSession()
      session.start(ReactContext(), first.generation).join()
      val firstToken = HeadlessJsTaskContext.instance.last!!.data.values.getValue("taskToken")
      val firstStopped = session.waitForStop(first.generation, firstToken)
      val close = first.owner.close(first.generation)
      check(firstStopped.isDone && !close.isDone)
      failure(first.reopen(), "guest_process_occupied")
      first.endpoint.binder.die()
      close.join()
      val current = Guest(owner = BrowserGuestOwner.process)
      check(current.generation != first.generation)
      session.start(ReactContext(), current.generation).join()
      val config = requireNotNull(HeadlessJsTaskContext.instance.last)
      val token = config.data.values.getValue("taskToken")
      check(token != firstToken && config.data.values.getValue("generation") == current.generation)
      val active = HeadlessJsTaskContext.instance.active.toSet()
      check(active.size == 1)
      val stopped = session.waitForStop(current.generation, token)
      check(!stopped.isDone)
      val rejected = session.start(ReactContext(), first.generation).thenCompose {
        if (operation == "command") current.owner.command(first.generation, "{}")
        else current.owner.resume(current.activity, first.generation)
      }
      failure(rejected, "stale_guest_generation")
      check(HeadlessJsTaskContext.instance.active == active)
      check(HeadlessJsTaskContext.instance.last === config && !stopped.isDone)
      check(current.endpoint.binder.alive && current.endpoint.sends == 0)
      check(current.activity.activityLaunches == 0)
      failure(current.reopen(), "guest_process_occupied")
      val command = current.owner.command(current.generation, "{}")
      check(!command.isDone && current.endpoint.sends == 1)
      val presented = current.owner.resume(current.activity, current.generation)
      current.foreground(true)
      check(presented.join() == "{}")
      current.endpoint.binder.die()
      failure(command, "guest_process_exited")
      check(stopped.isDone && HeadlessJsTaskContext.instance.active.isEmpty())
      session.destroy()
    }
  }
  scenario("React task startup failure settles without releasing native owner") {
    val guest = Guest(owner = BrowserGuestOwner.process)
    HeadlessJsTaskContext.instance.fail = true
    val session = BrowserGuestReactSession()
    failure(session.start(ReactContext(), guest.generation), "react_task_unavailable")
    failure(guest.reopen(), "guest_process_occupied")
    check(HeadlessJsTaskContext.instance.active.isEmpty())
    session.destroy()
    guest.endpoint.binder.die()
  }
  scenario("startup timeout retains slot and late endpoint closes until death") {
    val guest = Guest(ready = false)
    Scheduler.advance(15000)
    failure(guest.open, "guest_open_timeout")
    failure(guest.reopen(), "guest_process_occupied")
    guest.attach()
    check(guest.endpoint.sends == 1 && HeadlessJsTaskContext.instance.active.isEmpty())
    guest.endpoint.binder.die()
    check(!guest.reopen().isDone)
  }
  scenario("link failure is unavailable, not confirmed death") {
    val guest = Guest(ready = false)
    guest.endpoint.binder.linkFailure = DeadObjectException()
    guest.attach()
    failure(guest.open, "guest_transport_unavailable")
    failure(guest.reopen(), "guest_process_occupied")
    check(guest.endpoint.binder.alive)
  }
  scenario("fixture terminate send failure cannot report success") {
    val guest = Guest()
    guest.endpoint.binder.failure = TransactionTooLargeException()
    failure(guest.owner.terminateFixture(guest.generation), "guest_transport_unavailable")
    failure(guest.reopen(), "guest_process_occupied")
    check(guest.endpoint.sends == 1)
  }
}
